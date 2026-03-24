require('dotenv').config()
const express = require('express')
const cors = require('cors')
const OpenAI = require('openai')

const app = express()
app.use(cors())
app.use(express.json())

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FitTrack API' })
})

app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body

    const systemPrompt = `You are FitTrack AI, a personal fitness coach for Chris Tailor.

CHRIS'S PROFILE:
- Age: 24, Male
- Current weight: ${context?.weight || 130} lbs
- Body fat: ${context?.bodyFat || 15}%
- Goal: Lean muscle gain + performance
- Training: 7 days/week, advanced level
- Current streak: ${context?.streak || 0} days

TODAY'S WORKOUT: ${context?.todayWorkout || 'Not logged yet'}
PROTEIN TODAY: ${context?.proteinToday || 0}g of 150g target

MEAL PLAN (Indian home-cooked, mom cooks):
- Breakfast: Banana + Whey Shake (35g protein)
- Lunch: Chicken + Dal + Roti / Paneer / Fish Curry / Tofu (rotates)
- Dinner: Fish Curry + Rice / Egg White Curry / Chicken + Sabzi (rotates)
- Snack: Whey Protein Shake

YOUR STYLE:
- Direct, no fluff, like a real coach
- Reference his actual numbers
- Keep responses to 2-4 sentences unless asked for detail
- You know him well - be personal`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 300,
      temperature: 0.7,
    })

    res.json({ reply: completion.choices[0].message.content })
  } catch (error) {
    console.error('Chat error:', error)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`FitTrack API running on port ${PORT}`))
