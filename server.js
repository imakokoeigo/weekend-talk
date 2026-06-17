const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/image', express.static(path.join(__dirname, 'image')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── JSON extraction (handles markdown code fences) ───
function extractArray(text) {
  const m = text.match(/\[[\s\S]*?\]/);
  return m ? JSON.parse(m[0]) : JSON.parse(text.trim());
}

function extractObject(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : JSON.parse(text.trim());
}

// ── Chip generation prompts ──────────────────────────
function chipPrompt(questionId, answers) {
  const { adj, reason, example1 } = answers;

  const map = {
    reason: `
A Japanese English learner had a "${adj}" weekend.
Generate 6 short English phrases (5–10 words, first person, past tense)
that explain WHY their weekend felt "${adj}".
Return ONLY a valid JSON array of strings. No explanation.
Example format: ["I was able to sleep in", "I had no plans at all"]`,

    example1: `
Weekend felt "${adj}" because: "${reason}".
Generate 6 specific English phrases for things this person might have done over the weekend — include two different types of activities.
Each phrase starts with a past-tense verb, 4–8 words.
Return ONLY a valid JSON array of strings.
Example: ["went to a café with a friend", "stayed home watching Netflix"]`,

    feeling: `
Weekend activities: "${example1}".
Generate 6 English adjectives or very short phrases (1–3 words)
describing how these activities felt.
Return ONLY a valid JSON array of strings.
Example: ["delicious", "so relaxing", "really fun"]`,

    now: `
The user had a "${adj}" weekend doing: "${example1}".
Generate 6 short English phrases (5–10 words) about how they feel
heading into the new week.
Return ONLY a valid JSON array of strings.
Example: ["ready for a new week", "feeling refreshed and motivated"]`,
  };

  return map[questionId] || '';
}

// POST /api/chips ─────────────────────────────────────
app.post('/api/chips', async (req, res) => {
  const { questionId, answers } = req.body;
  const prompt = chipPrompt(questionId, answers);
  if (!prompt) return res.json({ chips: [] });

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const chips = extractArray(msg.content[0].text);
    res.json({ chips });
  } catch (err) {
    console.error('[chips]', err.message);
    res.status(500).json({ chips: [] });
  }
});

// POST /api/translate ─────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ suggestions: [] });

  const prompt = `
A Japanese English learner typed this in Japanese: "${text}"
Generate 3 natural English phrases they could say instead,
suitable for a short spoken speech about their weekend.
Keep each phrase short and conversational (under 12 words).
Return ONLY a valid JSON array of 3 strings. No explanation.
Example: ["it was really fun", "I had such a great time", "I really enjoyed it"]`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const suggestions = extractArray(msg.content[0].text);
    res.json({ suggestions });
  } catch (err) {
    console.error('[translate]', err.message);
    res.json({ suggestions: [] });
  }
});

// POST /api/followup ──────────────────────────────────
app.post('/api/followup', async (req, res) => {
  const { questionId, answer, answers, followUpCount } = req.body;
  const { adj = '', example1 = '' } = answers || {};

  // adj never needs follow-up (one word is perfect)
  if (questionId === 'adj') return res.json({ sufficient: true });

  // Max follow-up counts per question
  const maxCounts = { example1: 3, reason: 1, feeling: 1, now: 1 };
  const max = maxCounts[questionId] ?? 1;
  if ((followUpCount || 0) >= max) return res.json({ sufficient: true });

  const prompts = {
    reason: `
A Japanese English learner described their weekend as "${adj}".
Their reason: "${answer}"

Is this reason specific enough for a PREP speech?
- Sufficient: clear reason (e.g. "I could sleep in", "I spent time with my family")
- Insufficient: too vague (e.g. single word, "it was good")

If insufficient, write ONE short follow-up question IN JAPANESE to get more detail.
Return ONLY JSON — no markdown: {"sufficient": true} OR {"sufficient": false, "question": "日本語の質問"}`,

    example1: `
A Japanese English learner's weekend was "${adj}".
Their episode(s) so far: "${answer}"
Follow-up questions asked so far: ${followUpCount || 0} (max 3)

Goal: collect 2 specific episodes with enough detail for an 80-100 word speech.

Evaluate:
- If fewer than 2 distinct episodes → ask about a second one
- If 2 episodes but very vague → ask for one specific detail
- If 2 episodes with reasonable detail → return sufficient: true

Write the follow-up question IN JAPANESE, conversationally and friendly.
Return ONLY JSON — no markdown: {"sufficient": true} OR {"sufficient": false, "question": "日本語の質問"}`,

    feeling: `
A Japanese English learner described how their weekend felt: "${answer}"
One or two words are perfectly fine. Only return sufficient: false if completely empty or nonsensical.
If asking a follow-up, write it IN JAPANESE.
Return ONLY JSON: {"sufficient": true} OR {"sufficient": false, "question": "日本語の質問"}`,

    now: `
A Japanese English learner's mood heading into the new week: "${answer}"
Context: "${adj}" weekend, did "${example1}".
A short phrase is fine. Only ask if too vague to build a sentence from.
If asking a follow-up, write it IN JAPANESE.
Return ONLY JSON: {"sufficient": true} OR {"sufficient": false, "question": "日本語の質問"}`,
  };

  const prompt = prompts[questionId];
  if (!prompt) return res.json({ sufficient: true });

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = extractObject(msg.content[0].text);
    res.json({
      sufficient: result.sufficient !== false,
      question: result.question || null,
    });
  } catch (err) {
    console.error('[followup]', err.message);
    res.json({ sufficient: true }); // fail gracefully → just proceed
  }
});

// POST /api/speech ────────────────────────────────────
app.post('/api/speech', async (req, res) => {
  const { adj, reason, example1, feeling, now } = req.body.answers;

  const prompt = `
You help a Japanese English learner write a PREP-structure "Weekend Talk" speech.

Student's answers (may include Japanese — translate naturally into English):
- Weekend feeling : "${adj}"
- Reason          : "${reason}"
- Two episodes    : "${example1}"
- How it felt     : "${feeling}"
- Current mood    : "${now}"

Write a natural spoken-English speech and return ONLY this JSON object (no markdown, no extra text):

{
  "point":      "2 sentences — My weekend was [adj]. This is because [reason].",
  "example":    "3–4 sentences — Expand the two episodes into natural English. End with how it felt.",
  "conclusion": "2 sentences — Overall, it was a [adj] weekend. Now I feel [now].",
  "notes":      ["note1", "note2"]
}

Rules:
- Translate any Japanese naturally to English
- Expand vague or short answers into natural English sentences
- Total word count across point + example + conclusion: 80–100 words
- Vary sentence structure so it sounds natural when spoken
- For the "notes" array: write in Japanese, listing ONLY significant inferences or creative additions you made
  (e.g. "「本を読んだ」→ ミステリー小説として具体化しました"). Keep each note short.
  If the student's answers were already clear and specific, return an empty array [].`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = extractObject(msg.content[0].text);
    const { notes, ...sections } = result;
    res.json({ sections, notes: Array.isArray(notes) ? notes : [] });
  } catch (err) {
    console.error('[speech]', err.message);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Weekend Talk running on port ${PORT}`));
