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

const REMOVE_FOOD_TOOL = {
  name: 'remove_food',
  description: 'Remove food items that are already in the log. Use this whenever the user wants something taken off — "remove the coffee", "delete the bagel", "I didn\'t actually eat the pizza", "that was a mistake", "undo the last one", "clear today". Only remove items that actually appear in the log shown to you.',
  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'The day to remove from, as YYYY-MM-DD. Omit for today.'
      },
      items: {
        type: 'array',
        description: 'The logged items to remove. Copy the id and name exactly as they appear in the log above. Omit when "all" is true.',
        items: {
          type: 'object',
          properties: {
            id:   { type: 'string', description: 'The id shown in square brackets next to the item in the log. Always include it when it is shown.' },
            name: { type: 'string', description: 'The item name exactly as it appears in the log — used as a fallback if the id no longer matches.' }
          },
          required: ['name']
        }
      },
      all: {
        type: 'boolean',
        description: 'Set true ONLY when the user asks to clear/wipe the entire day.'
      },
      reply: {
        type: 'string',
        description: 'Brief response confirming what was removed and the updated remaining totals.'
      }
    },
    required: ['reply']
  }
};

const REPLY_TOOL = {
  name: 'reply_to_user',
  description: 'Answer the user without changing the log. Use this for questions, advice, recommendations, trends, encouragement, or general chat — anything that is not adding or removing a logged item.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Your conversational response.' }
    },
    required: ['reply']
  }
};

// The chat history the page sends already ends with the message we are about to
// send, and the Messages API requires the conversation to start with a user turn.
// Normalise both here so a cached older copy of food.html can't produce a
// malformed request (which used to surface as the assistant "ignoring" a log).
function normalizeHistory(history, message) {
  let msgs = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-8);
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user' && last.content.trim() === String(message).trim()) msgs.pop();
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

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

  // Items are rendered with their ids so remove_food can target an exact row.
  function renderEntry(e, indent) {
    const id = e && e.id ? `[${e.id}] ` : '';
    return `${indent}${id}${e.name}: ${e.calories} kcal, ${e.protein}g protein`;
  }

  // Render past days WITH their individual meals so the model can recall macros
  // ("same pasta as yesterday") and target a specific date for corrections.
  function renderPastDays() {
    if (!Array.isArray(foodHistory) || !foodHistory.length) return 'No past days recorded yet.';
    return foodHistory.map(h => {
      const head = `${h.date}: ${h.calories || 0} kcal, ${h.protein || 0}g protein`;
      const items = Array.isArray(h.entries) && h.entries.length
        ? '\n' + h.entries.map(e => renderEntry(e, '    - ')).join('\n')
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
  : foodLog.map(e => renderEntry(e, '• ')).join('\n')}

Past days (most recent last), with their individual meals:
${renderPastDays()}

You MUST answer every message by calling exactly one tool. Never reply with plain text.
- log_food — the user ate/drank something, or wants something added to a day.
- remove_food — the user wants something taken off a day, or the day cleared.
- reply_to_user — everything else (questions, advice, trends, chat).

Never say you will log or remove something without calling the matching tool in the SAME reply — say it and do it together, in one turn. If the amount is vague, estimate sensibly, log it anyway, and say what you assumed; do not ask for permission first.

Logging rules (log_food):
- Default to today (omit "date") unless the user clearly refers to another day.
- Corrections to a past day ("I forgot a snack yesterday", "add a coffee to Monday"): set "date" to that day's YYYY-MM-DD from the list above. "Yesterday" = the day before ${todayStr}.
- Repeating a past meal ("same protein pasta as yesterday", "the usual breakfast"): find that meal in the Past days list, reuse its exact macros, and log it (to today unless they say otherwise).
- If a referenced past meal isn't in the data, estimate the macros and say you estimated.

Removal rules (remove_food):
- Only remove items that appear in the log above. Copy each item's id (the value in square brackets) and its name exactly.
- "Undo that" / "remove the last one" → the last item in today's log.
- Removing part of a meal the user swapped ("actually that was a small coffee, not a large") → remove the old item and call log_food for the replacement in a follow-up if needed; prefer remove_food when they only want it gone.
- Set "all": true only for an explicit request to clear the whole day.
- If the item they name genuinely is not in the log, use reply_to_user to say so instead of guessing at a different item.

Be concise, warm, and realistic with estimates, always factoring in remaining calories and protein.`;

  try {
    const messages = [
      ...normalizeHistory(history, message),
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: [LOG_FOOD_TOOL, REMOVE_FOOD_TOOL, REPLY_TOOL],
      // Force a tool call every turn. Without this the model sometimes answered
      // "sure, logging that!" as plain text and nothing was actually written —
      // the user had to repeat themselves to get it logged.
      tool_choice: { type: 'any' },
      messages,
    });

    let type      = 'chat';
    let entries   = [];
    let removals  = [];
    let removeAll = false;
    let date      = null;
    let reply     = '';
    let textReply = '';

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const input = block.input || {};
        if (block.name === 'log_food') {
          type    = 'log';
          entries = input.entries || [];
          date    = input.date || null;
          reply   = input.reply || '';
        } else if (block.name === 'remove_food') {
          type      = 'remove';
          removals  = input.items || [];
          removeAll = input.all === true;
          date      = input.date || null;
          reply     = input.reply || '';
        } else if (block.name === 'reply_to_user') {
          reply = input.reply || '';
        }
      } else if (block.type === 'text') {
        textReply += block.text;
      }
    }

    reply = (reply || textReply).trim() || 'Got it!';
    res.json({ type, entries, removals, removeAll, date, reply });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
