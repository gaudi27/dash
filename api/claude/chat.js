const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOG_FOOD_TOOL = {
  name: 'log_food',
  description: 'Add food items to the daily nutrition log. Use this whenever the user mentions eating, consuming, or drinking something that has calories.',
  input_schema: {
    type: 'object',
    properties: {
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
        description: 'Brief encouraging response confirming what was logged and noting current progress'
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

  const { message, foodLog, goals, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });

  const calGoal  = goals?.calories || 2000;
  const protGoal = goals?.protein  || 150;
  const todayCals = (foodLog || []).reduce((s, e) => s + (e.calories || 0), 0);
  const todayProt = (foodLog || []).reduce((s, e) => s + (e.protein  || 0), 0);

  const systemPrompt = `You are a nutrition tracking assistant embedded in a personal dashboard.

Daily goals: ${calGoal} kcal · ${protGoal}g protein
Today so far: ${todayCals} kcal · ${todayProt}g protein (${calGoal - todayCals} kcal and ${protGoal - todayProt}g protein remaining)

Today's log:
${(foodLog || []).length === 0
  ? 'Nothing logged yet.'
  : foodLog.map(e => `• ${e.name}: ${e.calories} kcal, ${e.protein}g protein`).join('\n')}

Use the log_food tool when the user describes eating or drinking anything with calories.
For questions, advice, recommendations, or general chat — respond conversationally without calling the tool.
Be concise, warm, and realistic with nutrition estimates. When recommending foods, always factor in remaining calories and protein.`;

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

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'log_food') {
        entries = block.input.entries || [];
        reply   = block.input.reply   || '';
      } else if (block.type === 'text') {
        reply += block.text;
      }
    }

    reply = reply.trim() || 'Got it!';
    res.json({ entries, reply, type: entries.length ? 'log' : 'chat' });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
