exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
      headers: { 'Content-Type': 'application/json' }
    }
  }

  try {
    const response = await fetch('https://www.dmxapi.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DMXAPI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: event.body
    })

    const data = await response.text()

    return {
      statusCode: response.status,
      body: data,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
      headers: { 'Content-Type': 'application/json' }
    }
  }
}
