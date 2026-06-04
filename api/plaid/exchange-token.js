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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { public_token, institution } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    const tokenRes = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = tokenRes.data;

    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await supa
      .from('plaid_items')
      .upsert({ item_id, access_token, institution }, { onConflict: 'item_id' });

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('exchange-token error:', msg);
    res.status(500).json({ error: msg });
  }
};
