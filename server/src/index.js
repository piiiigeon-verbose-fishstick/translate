import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import translateRouter from './routes/translate.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    process.env.CLIENT_URL
  ].filter(Boolean)
}))
app.use(express.json({ limit: '5mb' }))

app.use('/api/translate', translateRouter)
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log(`Translation server running on port ${PORT}`)
})
