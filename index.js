require('dotenv').config()
const express = require('express')
const cors = require('cors')
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json())

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FitTrack API v2' })
})

// =============================================
// AI CHAT — Personal trainer for any user
// =============================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body

    const systemPrompt = `You are FitTrack AI, a personal fitness coach.

USER PROFILE:
- Name: ${context?.name || 'User'}
- Weight: ${context?.weight || 'unknown'} lbs
- Body fat: ${context?.bodyFat || 'unknown'}%
- Goal: ${context?.goal || 'improve fitness'}
- Training: ${context?.trainingDays || 3} days/week
- Current streak: ${context?.streak || 0} days

TODAY'S WORKOUT: ${context?.todayWorkout || 'Not logged yet'}
PROTEIN TODAY: ${context?.proteinToday || 0}g of ${context?.proteinTarget || 120}g target

YOUR STYLE:
- Direct, no fluff, like a real coach
- Reference their actual numbers
- Keep responses to 2-4 sentences unless asked for detail
- Be encouraging but honest`

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

// =============================================
// GENERATE PLAN — Called after onboarding
// Creates a personalized workout + meal plan
// =============================================
app.post('/api/generate-plan', async (req, res) => {
  try {
    const { userId, goal, activityLevel, trainingDays, dietType, weightLbs, heightCm, name } = req.body

    // Build the prompt for GPT-4o
    const prompt = `Create a fitness plan for this person:
Name: ${name}
Goal: ${goal}
Activity Level: ${activityLevel}
Training Days Per Week: ${trainingDays}
Diet Type: ${dietType}
Weight: ${weightLbs || 'unknown'} lbs
Height: ${heightCm || 'unknown'} cm

Return ONLY valid JSON with this exact structure:
{
  "workoutPlan": {
    "name": "plan name",
    "days": [
      {
        "dayNumber": 1,
        "dayName": "Day name",
        "muscleGroups": ["muscle1", "muscle2"],
        "exercises": [
          {"name": "Exercise name", "sets": 3, "reps": "8-12", "restSeconds": 90}
        ]
      }
    ]
  },
  "mealPlan": {
    "name": "plan name",
    "dailyCalorieTarget": 2200,
    "dailyProteinTarget": 130,
    "days": [
      {
        "dayNumber": 1,
        "dayLabel": "Monday",
        "meals": [
          {"mealType": "breakfast", "name": "Meal name", "calories": 400, "proteinG": 35, "carbsG": 40, "fatG": 12, "instructions": "How to prepare"}
        ]
      }
    ]
  }
}

Rules:
- Create exactly ${trainingDays} workout days + ${7 - trainingDays} rest days (mark rest days with empty exercises array)
- Create 7 meal plan days
- Diet type is ${dietType} — only include appropriate foods
- If diet is vegetarian/vegan, no meat at all
- Keep it practical and achievable for ${activityLevel} level
- Protein target: ${goal === 'build_muscle' ? 'high (1g per lb bodyweight)' : goal === 'lose_fat' ? 'moderate-high (0.8g per lb)' : 'moderate (0.7g per lb)'}
- Return ONLY the JSON, no explanation`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    })

    const planData = JSON.parse(completion.choices[0].message.content)

    // Save workout plan to Supabase
    const { data: workoutPlan, error: wpError } = await supabase
      .from('workout_plans')
      .insert({
        user_id: userId,
        name: planData.workoutPlan.name,
        is_active: true,
        start_date: new Date().toISOString().split('T')[0],
      })
      .select()
      .single()

    if (!wpError && workoutPlan) {
      for (const day of planData.workoutPlan.days) {
        const { data: workoutDay } = await supabase
          .from('workout_days')
          .insert({
            plan_id: workoutPlan.id,
            day_number: day.dayNumber,
            day_name: day.dayName,
            muscle_groups: day.muscleGroups || [],
          })
          .select()
          .single()

        if (workoutDay && day.exercises?.length > 0) {
          for (let i = 0; i < day.exercises.length; i++) {
            const ex = day.exercises[i]
            // Find or create exercise
            let { data: exercise } = await supabase
              .from('exercises')
              .select('id')
              .eq('name', ex.name)
              .single()

            if (!exercise) {
              const { data: newEx } = await supabase
                .from('exercises')
                .insert({ name: ex.name, is_custom: false })
                .select()
                .single()
              exercise = newEx
            }

            if (exercise) {
              await supabase.from('workout_day_exercises').insert({
                workout_day_id: workoutDay.id,
                exercise_id: exercise.id,
                order_index: i,
                sets: ex.sets || 3,
                reps: String(ex.reps || '8-12'),
                rest_seconds: ex.restSeconds || 90,
              })
            }
          }
        }
      }
    }

    // Save meal plan to Supabase
    const { data: mealPlan, error: mpError } = await supabase
      .from('meal_plans')
      .insert({
        user_id: userId,
        name: planData.mealPlan.name,
        is_active: true,
        daily_calorie_target: planData.mealPlan.dailyCalorieTarget,
        daily_protein_target: planData.mealPlan.dailyProteinTarget,
      })
      .select()
      .single()

    if (!mpError && mealPlan) {
      for (const day of planData.mealPlan.days) {
        const { data: planDay } = await supabase
          .from('meal_plan_days')
          .insert({
            plan_id: mealPlan.id,
            day_number: day.dayNumber,
            day_label: day.dayLabel,
          })
          .select()
          .single()

        if (planDay && day.meals?.length > 0) {
          for (const meal of day.meals) {
            await supabase.from('meals').insert({
              plan_day_id: planDay.id,
              meal_type: meal.mealType,
              name: meal.name,
              calories: meal.calories,
              protein_g: meal.proteinG,
              carbs_g: meal.carbsG,
              fat_g: meal.fatG,
              instructions: meal.instructions || '',
            })
          }
        }
      }
    }

    res.json({ success: true, message: 'Plan generated and saved' })
  } catch (error) {
    console.error('Generate plan error:', error)
    // Don't fail the onboarding even if plan generation fails
    res.status(200).json({ success: true, message: 'Profile saved, plan generation pending' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`FitTrack API v2 running on port ${PORT}`))
