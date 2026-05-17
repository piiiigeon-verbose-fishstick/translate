import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import translateRouter from './routes/translate.js'

const app = express()
const PORT = process.env.PORT || 3001

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3001',
  process.env.CLIENT_URL,
  'https://woshuofanyinierduolongma.netlify.app'
].filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      console.warn(`[cors] Rejected origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`)
      callback(new Error(`Origin ${origin} not allowed by CORS`))
    }
  }
}))
app.use(express.json({ limit: '5mb' }))

app.use('/api/translate', translateRouter)
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log(`Translation server running on port ${PORT}`)
})
