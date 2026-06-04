const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

function localDateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: items, error } = await supa.from('plaid_items').select('*');
    if (error) throw new Error(error.message);
    if (!items || !items.length) return res.json({ items: [] });

    const startDate = localDateStr(90);
    const endDate   = localDateStr(0);

    const result = await Promise.all(items.map(async (item) => {
      try {
        const r = await plaid.transactionsGet({
          access_token: item.access_token,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset: 0 },
        });
        return {
          institution: item.institution,
          item_id: item.item_id,
          transactions: r.data.transactions.map(t => ({
            transaction_id: t.transaction_id,
            account_id: t.account_id,
            date: t.date,
            name: t.merchant_name || t.name,
            amount: t.amount,
            category: t.personal_finance_category?.primary || (t.category && t.category[0]) || '',
            pending: t.pending,
          })),
        };
      } catch (itemErr) {
        const code = itemErr.response?.data?.error_code;
        return {
          institution: item.institution,
          item_id: item.item_id,
          error: code || itemErr.message,
          transactions: [],
        };
      }
    }));

    res.json({ items: result });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('transactions error:', msg);
    res.status(500).json({ error: msg });
  }
};
