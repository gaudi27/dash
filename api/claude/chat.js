const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOG_FOOD_TOOL = {
  name: 'log_food',
  description: 'Add food items to the nutrition log. Use this whenever the user mentions eating, consuming, or drinking something with calories — including corrections to a previous day (e.g. "I forgot a snack yesterday") or repeating a past meal (e.g. "same pasta as yesterday").',
  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'The date the food was eaten, as YYYY-MM-DD. Omit for today. Use a past date (from the "Past days" list) to add or correct a previous day.'
      },
      entries: {
        type: 'array',
        description: 'List of food items to log',
        items: {
          type: 'object',
          properties: {
            name:     { type: 'string', description: 'Short descriptive name of the food' },
            calories: { type: 'number', description: 'Estimated calories' },
            protein:  { type: 'number', description: 'Estimated protein in grams' }
          },
          required: ['name', 'calories', 'protein']
        }
      },
      reply: {
        type: 'string',
        description: 'Brief encouraging response confirming what was logged (mention the day if it was a past date) and noting progress'
      }
    },
    required: ['entries', 'reply']
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, foodLog, goals, history, foodHistory, today } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });

  const calGoal  = goals?.calories || 2000;
  const protGoal = goals?.protein  || 150;
  const todayCals = (foodLog || []).reduce((s, e) => s + (e.calories || 0), 0);
  const todayProt = (foodLog || []).reduce((s, e) => s + (e.protein  || 0), 0);
  const todayStr = today || new Date().toISOString().slice(0, 10);

  // Render past days WITH their individual meals so the model can recall macros
  // ("same pasta as yesterday") and target a specific date for corrections.
  function renderPastDays() {
    if (!Array.isArray(foodHistory) || !foodHistory.length) return 'No past days recorded yet.';
    return foodHistory.map(h => {
      const head = `${h.date}: ${h.calories || 0} kcal, ${h.protein || 0}g protein`;
      const items = Array.isArray(h.entries) && h.entries.length
        ? '\n' + h.entries.map(e => `    - ${e.name}: ${e.calories} kcal, ${e.protein}g protein`).join('\n')
        : '';
      return `• ${head}${items}`;
    }).join('\n');
  }

  const systemPrompt = `You are a nutrition tracking assistant embedded in a personal dashboard.

Today's date is ${todayStr}.
Daily goals: ${calGoal} kcal · ${protGoal}g protein
Today so far: ${todayCals} kcal · ${todayProt}g protein (${calGoal - todayCals} kcal and ${protGoal - todayProt}g protein remaining)

Today's log:
${(foodLog || []).length === 0
  ? 'Nothing logged yet.'
  : foodLog.map(e => `• ${e.name}: ${e.calories} kcal, ${e.protein}g protein`).join('\n')}

Past days (most recent last), with their individual meals:
${renderPastDays()}

Logging rules — use the log_food tool whenever the user describes eating/drinking anything with calories:
- Default to today (omit "date") unless the user clearly refers to another day.
- Corrections to a past day ("I forgot a snack yesterday", "add a coffee to Monday"): set "date" to that day's YYYY-MM-DD from the list above. "Yesterday" = the day before ${todayStr}.
- Repeating a past meal ("same protein pasta as yesterday", "the usual breakfast"): find that meal in the Past days list, reuse its exact macros, and log it (to today unless they say otherwise).
- If a referenced past meal isn't in the data, estimate the macros and say you estimated.

For questions, advice, recommendations, trends, or general chat — respond conversationally WITHOUT calling the tool. Be concise, warm, and realistic with estimates, always factoring in remaining calories and protein.`;

  try {
    const messages = [
      ...(history || []).slice(-8),
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: [LOG_FOOD_TOOL],
      messages,
    });

    let entries = [];
    let reply   = '';
    let date    = null;

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'log_food') {
        entries = block.input.entries || [];
        reply   = block.input.reply   || '';
        date    = block.input.date || null;
      } else if (block.type === 'text') {
        reply += block.text;
      }
    }

    reply = reply.trim() || 'Got it!';
    res.json({ entries, date, reply, type: entries.length ? 'log' : 'chat' });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
