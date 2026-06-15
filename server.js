const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const { adj, reason, example1, example2 } = answers;

  const map = {
    reason: `
A Japanese English learner had a "${adj}" weekend.
Generate 6 short English phrases (5–10 words, first person, past tense)
that explain WHY their weekend felt "${adj}".
Return ONLY a valid JSON array of strings. No explanation.
Example format: ["I was able to sleep in", "I had no plans at all"]`,

    example1: `
Weekend felt "${adj}" because: "${reason}".
Generate 5 specific English activity phrases this person might have done.
Each phrase starts with a past-tense verb, 4–8 words.
Return ONLY a valid JSON array of strings.
Example: ["went to a café in the neighborhood", "stayed home watching Netflix"]`,

    example2: `
After "${example1}" on the weekend.
Generate 5 natural follow-up activities for the rest of the weekend.
Each starts with a past-tense verb, 4–8 words.
Return ONLY a valid JSON array of strings.
Example: ["went for a walk in the park", "cooked a simple dinner at home"]`,

    feeling: `
Weekend activities: "${example1}" and "${example2}".
Generate 6 English adjectives or very short phrases (1–3 words)
describing how these activities felt.
Return ONLY a valid JSON array of strings.
Example: ["delicious", "so relaxing", "really fun"]`,

    now: `
The user had a "${adj}" weekend: "${example1}", then "${example2}".
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
  if (!prompt) return res.json({ chips: [] }); // ping or unknown → return empty

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
    res.status(500).json({ chips: [] }); // fail gracefully → free input only
  }
});

// POST /api/speech ────────────────────────────────────
app.post('/api/speech', async (req, res) => {
  const { adj, reason, example1, example2, feeling, now } = req.body.answers;

  const prompt = `
You help a Japanese English learner write a PREP-structure "Weekend Talk" speech.

Student's answers (may include Japanese — translate naturally into English):
- Weekend feeling : "${adj}"
- Reason          : "${reason}"
- Main activity   : "${example1}"
- After that      : "${example2}"
- How it felt     : "${feeling}"
- Current mood    : "${now}"

Write a natural spoken-English speech and return ONLY this JSON object
(no markdown, no extra text):

{
  "point":      "2 sentences — My weekend was really [adj]. This is because [reason].",
  "example":    "3 sentences — For example, [example1]. After that, [example2]. It was really [feeling]!",
  "conclusion": "2 sentences — Overall, I had a [adj] weekend. Now I am [now]."
}

Rules:
- Translate any Japanese naturally to English
- Keep it conversational and natural (80–110 words total across all three fields)
- Vary sentence structure slightly so it doesn't sound robotic`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const sections = extractObject(msg.content[0].text);
    res.json({ sections });
  } catch (err) {
    console.error('[speech]', err.message);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Weekend Talk running on port ${PORT}`));
