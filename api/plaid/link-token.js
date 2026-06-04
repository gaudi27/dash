const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

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

  try {
    const request = {
      user: { client_user_id: 'dashboard-user' },
      client_name: "George's Dashboard",
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    };
    if (process.env.PLAID_REDIRECT_URI) {
      request.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
    const response = await plaid.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('link-token error:', msg);
    res.status(500).json({ error: msg });
  }
};
