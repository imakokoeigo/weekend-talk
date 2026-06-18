const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/image', express.static(path.join(__dirname, 'image')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractArray(text) {
  const m = text.match(/\[[\s\S]*?\]/);
  return m ? JSON.parse(m[0]) : JSON.parse(text.trim());
}
function extractObject(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : JSON.parse(text.trim());
}

// ── CHIP PROMPTS ──────────────────────────────────────
function chipPrompt(templateId, questionId, answers) {
  if (templateId === 'weekend') return weekendChipPrompt(questionId, answers);
  if (templateId === 'myFavorite') return myFavoriteChipPrompt(questionId, answers);
  return '';
}

function weekendChipPrompt(questionId, answers) {
  const { adj, reason, example1 } = answers;
  const map = {
    reason: `
A Japanese English learner had a "${adj}" weekend.
Generate 6 short English phrases (5–10 words, first person, past tense)
explaining WHY their weekend felt "${adj}".
Return ONLY a valid JSON array. Example: ["I was able to sleep in", "I had no plans"]`,

    example1: `
Weekend felt "${adj}" because: "${reason}".
Generate 6 English phrases for things this person might have done — two different activity types.
Each starts with a past-tense verb, 4–8 words.
Return ONLY a valid JSON array. Example: ["went to a café with a friend", "stayed home watching Netflix"]`,

    feeling: `
Weekend activities: "${example1}".
Generate 6 English adjectives or short phrases (1–3 words) describing how these felt.
Return ONLY a valid JSON array. Example: ["delicious", "so relaxing", "really fun"]`,

    now: `
The user had a "${adj}" weekend doing: "${example1}".
Generate 6 short English phrases (5–10 words) about how they feel heading into the new week.
Return ONLY a valid JSON array. Example: ["ready for a new week", "feeling refreshed and motivated"]`,
  };
  return map[questionId] || '';
}

function myFavoriteChipPrompt(questionId, answers) {
  const { genre = '', item = '', episode = '' } = answers;
  const map = {
    item: `
A Japanese English learner likes the genre "${genre}".
Generate 8 specific examples within "${genre}" they might enjoy. Keep each 1–4 words.
Return ONLY a valid JSON array.
Example (for music): ["jazz piano", "classical guitar", "K-pop", "bossa nova"]`,

    feeling: `
A Japanese English learner loves "${item}" (genre: "${genre}").
Generate 6 English words or short phrases (1–3 words) describing how it makes them feel.
Return ONLY a valid JSON array. Example: ["relaxed", "energized", "so happy", "inspired"]`,

    habit: `
A Japanese English learner loves "${item}".
Generate 5 English phrases (under 8 words) describing when/where/with whom they enjoy it.
Return ONLY a valid JSON array. Example: ["every weekend at home alone", "with friends at a café"]`,

    episode: `
A Japanese English learner loves "${item}".
Generate 5 English phrases for specific experiences they might have had.
Start each with a time reference + past tense verb.
Return ONLY a valid JSON array. Example: ["last month, attended a live concert", "last year, visited a gallery in Tokyo"]`,

    impression: `
A Japanese English learner had this experience with "${item}": "${episode}".
Generate 6 English adjectives or short phrases (1–3 words) describing how it felt.
Return ONLY a valid JSON array. Example: ["amazing", "unforgettable", "truly inspiring"]`,

    future: `
A Japanese English learner loves "${item}".
Generate 5 English phrases about future aspirations related to "${item}". Start each with a verb.
Return ONLY a valid JSON array. Example: ["visit a jazz festival in New York", "learn to play the guitar"]`,
  };
  return map[questionId] || '';
}

// POST /api/chips ─────────────────────────────────────
app.post('/api/chips', async (req, res) => {
  const { templateId, questionId, answers } = req.body;
  const prompt = chipPrompt(templateId, questionId, answers || {});
  if (!prompt) return res.json({ chips: [] });

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ chips: extractArray(msg.content[0].text) });
  } catch (err) {
    console.error('[chips]', err.message);
    res.json({ chips: [] });
  }
});

// POST /api/translate ─────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ suggestions: [] });

  const prompt = `
A Japanese English learner typed this in Japanese: "${text}"
Generate 3 natural English phrases they could say instead, suitable for a short spoken speech.
Keep each phrase short and conversational (under 12 words).
Return ONLY a valid JSON array of 3 strings.
Example: ["it was really fun", "I had such a great time", "I really enjoyed it"]`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ suggestions: extractArray(msg.content[0].text) });
  } catch (err) {
    console.error('[translate]', err.message);
    res.json({ suggestions: [] });
  }
});

// POST /api/followup ──────────────────────────────────
app.post('/api/followup', async (req, res) => {
  const { templateId, questionId, answer, answers, followUpCount } = req.body;
  const cnt = followUpCount || 0;

  const prompt = buildFollowupPrompt(templateId, questionId, answer, answers || {}, cnt);
  if (!prompt) return res.json({ sufficient: true });

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = extractObject(msg.content[0].text);
    res.json({ sufficient: result.sufficient !== false, question: result.question || null });
  } catch (err) {
    console.error('[followup]', err.message);
    res.json({ sufficient: true });
  }
});

function buildFollowupPrompt(templateId, questionId, answer, answers, cnt) {
  const { adj = '', item = '', episode = '' } = answers;

  // Max follow-up counts
  const maxCounts = {
    weekend:    { reason: 1, example1: 3, feeling: 1, now: 1 },
    myFavorite: { genre: 2, item: 2, feeling: 1, habit: 1, episode: 3, impression: 1, future: 1 },
  };
  const max = (maxCounts[templateId] || {})[questionId] ?? 1;
  if (cnt >= max) return '';

  const suffix = `\nFollow-up questions asked so far: ${cnt} (max ${max}).
${cnt >= max ? 'Return {"sufficient": true} — we have enough.' : ''}
Write follow-up question IN JAPANESE, natural and friendly.
Return ONLY JSON (no markdown): {"sufficient": true} OR {"sufficient": false, "question": "日本語の質問"}`;

  if (templateId === 'weekend') {
    const prompts = {
      reason: `Weekend was "${adj}". Reason given: "${answer}".
Is this specific enough? (vague = single word / "it was good". clear = actual reason with detail.)${suffix}`,

      example1: `Weekend was "${adj}". Episodes so far: "${answer}".
Goal: 2 specific episodes with enough detail for 80-100 words.
If < 2 episodes → ask for a second. If vague → ask for detail. If sufficient → return true.${suffix}`,

      feeling: `Feeling described as: "${answer}". One or two words is fine. Only ask if empty/nonsensical.${suffix}`,

      now: `Mood heading into new week: "${answer}". Context: "${adj}" weekend. Short phrase is fine.${suffix}`,
    };
    return prompts[questionId] || '';
  }

  if (templateId === 'myFavorite') {
    const prompts = {
      genre: `Student was asked "What genre do you like?" and answered: "${answer}"
Is this a reasonable genre or category? (music, books, sports, cooking, art, movies, fashion, travel, etc. are all fine)
Only ask again if the answer is completely off-topic, nonsensical, or unrelated to a hobby/interest.
A broad or specific answer is both acceptable.${suffix}`,

      item: `Genre: "${genre}". Specific favorite: "${answer}"
Does "${answer}" make sense as a specific thing within "${genre}"?
Only ask if clearly off-topic or if they just repeated the genre without being more specific.${suffix}`,

      feeling: `Favorite thing: "${item}". Feeling described as: "${answer}". One or two words is fine.${suffix}`,

      habit: `Favorite: "${item}". How/when/where they enjoy it: "${answer}".
Is this specific enough to build a sentence? (needs at least one of: when / with whom / where)${suffix}`,

      episode: `Favorite: "${item}". Episode so far: "${answer}".
Goal: a specific episode with time reference + what they did, enough for 2-3 sentences.
If missing time ref → ask when. If vague activity → ask what exactly. If sufficient → return true.${suffix}`,

      impression: `Impression of experience: "${answer}". One or two words is fine.${suffix}`,

      future: `Future aspiration: "${answer}". Needs a specific activity (not just "I want to enjoy it more").${suffix}`,
    };
    return prompts[questionId] || '';
  }

  return '';
}

// POST /api/speech ────────────────────────────────────
app.post('/api/speech', async (req, res) => {
  const { templateId, answers } = req.body;
  const prompt = buildSpeechPrompt(templateId, answers);

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 600,
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

function buildSpeechPrompt(templateId, answers) {
  if (templateId === 'myFavorite') {
    const { genre, item, feeling, habit, episode, impression, future } = answers;
    return `
You help a Japanese English learner write a PREP-structure "My Favorite" speech.

Student's answers (translate Japanese naturally):
- Genre (❶)      : "${genre}"
- Specific thing (❷) : "${item}"
- How it feels (❸)   : "${feeling}"
- How/when/where (❹❺❻): "${habit}"
- Episode (❼❽)   : "${episode}"
- Impression (❾) : "${impression}"
- Future goal (❿): "${future}"

Return ONLY this JSON (no markdown):
{
  "point":      "3 sentences — For today's topic, I chose \\"My favorite\\". My favorite [genre] is [item]. Actually, I'm really into it.",
  "reason":     "1 sentence — The reason I like it is that it makes me feel [feeling].",
  "example":    "3 sentences — I usually enjoy [item] [habit]. For example, [episode]. It was really [impression]!",
  "conclusion": "2 sentences — That's why [item] is my favorite. In the future, I want to [future].",
  "notes":      ["Japanese note about inference made"]
}

Rules:
- Keep opener fixed: 'For today\\'s topic, I chose "My favorite".'
- Translate Japanese naturally; expand vague answers
- Total: 80–100 words across all four sections
- notes: Japanese, only list significant inferences. Empty array [] if answers were clear.`;
  }

  // Default: weekend
  const { adj, reason, example1, feeling, now } = answers;
  return `
You help a Japanese English learner write a PREP-structure "Weekend Talk" speech.

Student's answers (translate Japanese naturally):
- Weekend feeling : "${adj}"
- Reason          : "${reason}"
- Two episodes    : "${example1}"
- How it felt     : "${feeling}"
- Current mood    : "${now}"

Return ONLY this JSON (no markdown):
{
  "point":      "2 sentences — My weekend was [adj]. This is because [reason].",
  "example":    "3–4 sentences — Expand the two episodes naturally. It was really [feeling]!",
  "conclusion": "2 sentences — Overall, it was a [adj] weekend. Now I feel [now].",
  "notes":      ["Japanese note about inference made"]
}

Rules:
- Translate Japanese naturally; expand vague answers
- Total: 80–100 words across all three sections
- notes: Japanese, only list significant inferences. Empty array [] if answers were clear.`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Speech Builder running on port ${PORT}`));
