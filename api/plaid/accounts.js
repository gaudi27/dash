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

    const result = await Promise.all(items.map(async (item) => {
      try {
        const r = await plaid.accountsBalanceGet({ access_token: item.access_token });
        return {
          institution: item.institution,
          item_id: item.item_id,
          accounts: r.data.accounts.map(a => ({
            account_id: a.account_id,
            name: a.name,
            official_name: a.official_name,
            type: a.type,
            subtype: a.subtype,
            balance: {
              available: a.balances.available,
              current: a.balances.current,
              currency: a.balances.iso_currency_code || 'USD',
            },
          })),
        };
      } catch (itemErr) {
        const code = itemErr.response?.data?.error_code;
        return {
          institution: item.institution,
          item_id: item.item_id,
          error: code || itemErr.message,
          accounts: [],
        };
      }
    }));

    res.json({ items: result });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('accounts error:', msg);
    res.status(500).json({ error: msg });
  }
};
