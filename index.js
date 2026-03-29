require('dotenv').config()
const express = require('express')
const cors = require('cors')
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')

// Startup env var check
const requiredEnvVars = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
requiredEnvVars.forEach(v => {
  if (!process.env[v]) console.error(`MISSING ENV VAR: ${v}`)
})

const app = express()
app.use(cors())
app.use(express.json())

// Request timeout middleware — 120s to allow GPT-4o to complete
app.use((req, res, next) => {
  req.setTimeout(120000)
  res.setTimeout(120000)
  next()
})

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
)

// Root health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FitTrack API v2', timestamp: new Date().toISOString() })
})

// =============================================
// CHAT TOOLS — OpenAI function calling definitions
// =============================================
const chatTools = [
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description: "Update the user's profile data when they mention new stats or want to change their goal/settings",
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: ['weight', 'goal', 'experience_level', 'activity_level', 'training_days_per_week', 'diet_type', 'age', 'height'],
          },
          value: { type: 'string', description: 'The new value as a string' },
        },
        required: ['field', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_body_composition',
      description: "Log body measurements when user mentions their current weight, body fat %, or muscle mass",
      parameters: {
        type: 'object',
        properties: {
          weight: { type: 'number' },
          body_fat_percentage: { type: 'number' },
          muscle_mass: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerate_plan',
      description: "Generate a new workout or meal plan when user asks for one",
      parameters: {
        type: 'object',
        properties: {
          plan_type: { type: 'string', enum: ['workout', 'meal', 'both'] },
        },
        required: ['plan_type'],
      },
    },
  },
]

// =============================================
// CHAT TOOL EXECUTORS
// =============================================
async function executeUpdateProfile(userId, args) {
  const { field, value } = args
  const numericFields = ['weight', 'age', 'training_days_per_week']
  const updateValue = numericFields.includes(field) ? Number(value) : value

  const { data, error } = await supabase
    .from('profiles')
    .update({ [field]: updateValue })
    .eq('id', userId)
    .select()
    .single()

  if (error) throw new Error(`Failed to update profile: ${error.message}`)
  return { success: true, field, value: updateValue }
}

async function executeLogBodyComposition(userId, args) {
  const logEntry = { user_id: userId, logged_at: new Date().toISOString() }
  if (args.weight != null) logEntry.weight = args.weight
  if (args.body_fat_percentage != null) logEntry.body_fat_percentage = args.body_fat_percentage
  if (args.muscle_mass != null) logEntry.muscle_mass = args.muscle_mass

  const { data, error } = await supabase
    .from('body_composition_logs')
    .insert(logEntry)
    .select()
    .single()

  if (error) throw new Error(`Failed to log body composition: ${error.message}`)
  return { success: true, logged: logEntry }
}

async function executeRegeneratePlan(userId, args) {
  const { plan_type } = args

  // Fetch current profile
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (profileError || !profile) throw new Error('Could not fetch user profile for plan regeneration')

  // Apply fallbacks for missing/null profile fields
  profile.age = profile.age || 25
  profile.gender = profile.gender || 'male'
  profile.weight = profile.weight || 150
  profile.height = profile.height || '5\'10"'
  profile.activity_level = profile.activity_level || 'moderately_active'
  profile.diet_type = profile.diet_type || 'balanced'
  profile.experience_level = profile.experience_level || 'intermediate'
  profile.training_days_per_week = profile.training_days_per_week || 4
  profile.goal = profile.goal || 'lean muscle'
  profile.full_name = profile.full_name || 'there'

  // Deactivate existing plans
  if (plan_type === 'workout' || plan_type === 'both') {
    await supabase.from('workout_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
  }
  if (plan_type === 'meal' || plan_type === 'both') {
    await supabase.from('meal_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
  }

  // Generate new plan using the same logic as /api/generate-plan
  await generateAndSavePlan(userId, profile, plan_type)
  return { success: true, plan_type, message: `New ${plan_type} plan generated` }
}

// =============================================
// AI CHAT — Personal trainer with function calling
// =============================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId, profileSnapshot, conversationHistory } = req.body

    if (!message || !userId) {
      return res.status(400).json({ error: 'message and userId are required' })
    }

    const p = profileSnapshot || {}
    const name = p.name || 'there'
    const systemPrompt = `You are ${name}'s personal AI fitness trainer. You know everything about them:

Profile:
- Name: ${name}, Age: ${p.age || 'unknown'}, Gender: ${p.gender || 'unknown'}
- Weight: ${p.weight || 'unknown'} lbs, Height: ${p.height || 'unknown'}
- Goal: ${p.goal || 'unknown'}
- Experience: ${p.experienceLevel || 'unknown'}
- Activity level: ${p.activityLevel || 'unknown'}
- Diet: ${p.dietType || 'unknown'}
- Training: ${p.trainingDaysPerWeek || 'unknown'} days/week

You are their dedicated trainer — encouraging, knowledgeable, and specific to THEIR situation. Never give generic advice. Always reference their actual stats, goals, and plan.

You can take real actions:
- Update their profile (weight, goal, training days, etc.)
- Log body composition measurements
- Generate a new workout or meal plan

When you decide to take an action (update profile, log measurements, generate a plan), phrase your response as a clear recommendation asking the user to confirm. For example: "I can update your weight to 143 lbs — shall I go ahead?" or "I recommend generating a new meal plan based on your updated goals. Want me to do that?" The app will show a confirm button for the user.

Always be conversational, motivating, and brief (2-4 sentences max unless they ask for detail). Use their name occasionally.`

    const messages = [{ role: 'system', content: systemPrompt }]

    // Include conversation history if provided
    if (Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory.slice(-10)) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    messages.push({ role: 'user', content: message })

    // First call — may return tool calls
    let completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: chatTools,
      tool_choice: 'auto',
      max_tokens: 500,
      temperature: 0.7,
    }, { timeout: 60000 })

    let assistantMessage = completion.choices[0].message

    // If GPT wants to call a tool, don't execute it — return as pendingAction for user confirmation
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolCall = assistantMessage.tool_calls[0]
      const toolName = toolCall.function.name
      const toolArgs = JSON.parse(toolCall.function.arguments)

      let pendingAction = null
      if (toolName === 'update_profile') {
        pendingAction = { type: 'profile_updated', field: toolArgs.field, value: toolArgs.value }
      } else if (toolName === 'log_body_composition') {
        pendingAction = { type: 'composition_logged', ...toolArgs }
      } else if (toolName === 'regenerate_plan') {
        pendingAction = { type: 'plan_regenerated', planType: toolArgs.plan_type }
      }

      // Use GPT's content if it provided one, otherwise generate a fallback confirmation message
      const message = assistantMessage.content || generateConfirmationText(pendingAction)
      return res.json({ message, pendingAction })
    }

    res.json({ message: assistantMessage.content })
  } catch (error) {
    console.error('Chat error:', error)
    res.status(500).json({ error: 'Chat failed. Please try again.' })
  }
})

// =============================================
// CONFIRMATION TEXT — Fallback when GPT doesn't provide content alongside tool calls
// =============================================
function generateConfirmationText(action) {
  if (!action) return "I'd like to make a change — shall I go ahead?"
  switch (action.type) {
    case 'profile_updated':
      return `I can update your ${action.field} to ${action.value} — want me to go ahead?`
    case 'composition_logged':
      const parts = []
      if (action.weight) parts.push(`weight: ${action.weight} lbs`)
      if (action.body_fat_percentage) parts.push(`body fat: ${action.body_fat_percentage}%`)
      if (action.muscle_mass) parts.push(`muscle mass: ${action.muscle_mass} lbs`)
      return `I can log your measurements (${parts.join(', ')}) — shall I save that?`
    case 'plan_regenerated':
      return `I can generate a new ${action.planType || 'workout and meal'} plan for you — want me to do that?`
    default:
      return "I'd like to make a change — shall I go ahead?"
  }
}

function getUpdateConfirmation(field, value) {
  const messages = {
    weight: `Done! I've updated your weight to ${value} lbs. Keep tracking your progress!`,
    goal: `Updated! Your goal is now set to "${value}". I'll adjust my recommendations accordingly.`,
    training_days_per_week: `Got it! Training days updated to ${value} per week.`,
    diet_type: `Updated your diet preference to ${value}.`,
    experience_level: `Experience level updated to ${value}.`,
    activity_level: `Activity level updated to ${value}.`,
    age: `Updated your age to ${value}.`,
    height: `Updated your height to ${value}.`,
  }
  return messages[field] || `Updated your ${field} to ${value}.`
}

// =============================================
// EXECUTE ACTION — Runs a confirmed pending action against the DB
// =============================================
app.post('/api/execute-action', async (req, res) => {
  const { userId, action } = req.body

  if (!userId || !action) {
    return res.status(400).json({ error: 'userId and action required' })
  }

  try {
    let confirmationMessage

    switch (action.type) {
      case 'profile_updated':
        await executeUpdateProfile(userId, { field: action.field, value: action.value })
        confirmationMessage = getUpdateConfirmation(action.field, action.value)
        break

      case 'composition_logged': {
        const logArgs = {}
        if (action.weight) logArgs.weight = action.weight
        if (action.body_fat_percentage) logArgs.body_fat_percentage = action.body_fat_percentage
        if (action.muscle_mass) logArgs.muscle_mass = action.muscle_mass
        await executeLogBodyComposition(userId, logArgs)
        confirmationMessage = "Logged! Your progress has been recorded."
        break
      }

      case 'plan_regenerated': {
        const planType = action.planType || 'both'
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single()

        if (profileError || !profile) {
          return res.status(404).json({ error: 'Profile not found' })
        }

        // Apply fallbacks
        profile.age = profile.age || 25
        profile.gender = profile.gender || 'male'
        profile.weight = profile.weight || 150
        profile.height = profile.height || '5\'10"'
        profile.activity_level = profile.activity_level || 'moderately_active'
        profile.diet_type = profile.diet_type || 'balanced'
        profile.experience_level = profile.experience_level || 'intermediate'
        profile.training_days_per_week = profile.training_days_per_week || 4
        profile.goal = profile.goal || 'lean muscle'
        profile.full_name = profile.full_name || 'there'

        // Deactivate existing plans
        if (planType === 'workout' || planType === 'both') {
          await supabase.from('workout_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
        }
        if (planType === 'meal' || planType === 'both') {
          await supabase.from('meal_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
        }

        await generateAndSavePlan(userId, profile, planType)
        confirmationMessage = `Done! Your new ${planType === 'both' ? 'workout and meal plan has' : planType + ' plan has'} been generated. Check the ${planType === 'meal' ? 'Nutrition' : 'Workout'} tab.`
        break
      }

      default:
        return res.status(400).json({ error: 'Unknown action type' })
    }

    res.json({ message: confirmationMessage, success: true })
  } catch (error) {
    console.error('[execute-action] Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// =============================================
// GENERATE PLAN — Called after onboarding
// Creates a personalized workout + meal plan
// =============================================
app.post('/api/generate-plan', async (req, res) => {
  try {
    const { userId } = req.body
    console.log(`[generate-plan] Starting for userId: ${userId}`)

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    // Fetch full profile from Supabase
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    console.log(`[generate-plan] Profile fetched: ${profile ? 'yes' : 'no'}${profileError ? ', error: ' + profileError.message : ''}`)

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found for this user' })
    }

    // Apply fallbacks for missing/null profile fields
    profile.age = profile.age || 25
    profile.gender = profile.gender || 'male'
    profile.weight = profile.weight || 150
    profile.height = profile.height || '5\'10"'
    profile.activity_level = profile.activity_level || 'moderately_active'
    profile.diet_type = profile.diet_type || 'balanced'
    profile.experience_level = profile.experience_level || 'intermediate'
    profile.training_days_per_week = profile.training_days_per_week || 4
    profile.goal = profile.goal || 'lean muscle'
    profile.full_name = profile.full_name || 'there'

    // Deactivate existing active plans
    await supabase.from('workout_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
    await supabase.from('meal_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
    console.log(`[generate-plan] Deactivated existing plans`)

    await generateAndSavePlan(userId, profile, 'both')

    console.log(`[generate-plan] Complete`)
    res.json({ success: true, message: 'Plan generated and saved' })
  } catch (error) {
    console.error('[generate-plan] Error:', error.message || error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Plan generation failed. Please try again.', details: error.message })
    }
  }
})

// =============================================
// CORE PLAN GENERATION LOGIC
// =============================================
async function generateAndSavePlan(userId, profile, planType) {
  const {
    full_name, age, gender, weight, height,
    goal, experience_level, activity_level,
    diet_type, training_days_per_week
  } = profile

  const trainingDays = training_days_per_week || 4

  // Fetch available exercises from Supabase
  const { data: availableExercises } = await supabase
    .from('exercises')
    .select('id, name, muscle_group, equipment')
    .order('name')

  const exerciseList = (availableExercises || [])
    .map(e => `- ID:${e.id} "${e.name}" (${e.muscle_group || 'general'}${e.equipment ? ', ' + e.equipment : ''})`)
    .join('\n')

  // TDEE and macro calculation instructions
  const tdeeInstructions = `
CALORIE CALCULATION (MUST follow these steps):
1. Calculate BMR using Mifflin-St Jeor:
   - Male: BMR = (10 × weight_kg) + (6.25 × height_cm) − (5 × age) + 5
   - Female: BMR = (10 × weight_kg) + (6.25 × height_cm) − (5 × age) − 161
   - User weight: ${weight}lbs (=${Math.round(weight * 0.453592)}kg), height: ${height}cm, age: ${age}, gender: ${gender || 'male'}
2. Multiply BMR by activity factor:
   - Sedentary: ×1.2, Lightly active: ×1.375, Moderately active: ×1.55, Very active: ×1.725
   - User activity level: ${activity_level || 'moderately active'}
3. Adjust for goal:
   - ${goal === 'build_muscle' || goal === 'lean_muscle' ? 'Muscle building: add +300 calories (lean surplus)' : ''}
   - ${goal === 'lose_fat' || goal === 'weight_loss' ? 'Fat loss: subtract -500 calories (moderate deficit)' : ''}
   - ${goal !== 'build_muscle' && goal !== 'lean_muscle' && goal !== 'lose_fat' && goal !== 'weight_loss' ? 'Maintenance: use TDEE as-is' : ''}

MACRO SPLIT (MUST match goal):
${goal === 'build_muscle' || goal === 'lean_muscle'
    ? '- Protein: 40% of calories, Carbs: 30%, Fat: 30%'
    : goal === 'lose_fat' || goal === 'weight_loss'
      ? '- Protein: 40% of calories, Carbs: 35%, Fat: 25%'
      : '- Protein: 30% of calories, Carbs: 40%, Fat: 30%'}
`

  const generateWorkout = planType === 'workout' || planType === 'both'
  const generateMeal = planType === 'meal' || planType === 'both'

  const prompt = `Create a personalized fitness plan for this person:
Name: ${full_name || 'User'}
Age: ${age}, Gender: ${gender || 'not specified'}
Weight: ${weight} lbs (${Math.round(weight * 0.453592)} kg)
Height: ${height} cm
Goal: ${goal}
Experience Level: ${experience_level || 'beginner'}
Activity Level: ${activity_level || 'moderately active'}
Training Days Per Week: ${trainingDays}
Diet Type: ${diet_type || 'omnivore'}

${tdeeInstructions}

${exerciseList.length > 0 ? `AVAILABLE EXERCISES (you MUST use exercise IDs from this list when possible):
${exerciseList}

For each exercise in the workout, include the "exerciseId" field with the matching ID from the list above. Only create exercises without an ID if no suitable match exists.` : ''}

Return ONLY valid JSON with this exact structure:
{
  ${generateWorkout ? `"workoutPlan": {
    "name": "plan name based on goal and experience",
    "days": [
      {
        "dayNumber": 1,
        "dayName": "Day name (e.g., Push Day, Upper Body, Rest)",
        "muscleGroups": ["chest", "shoulders", "triceps"],
        "exercises": [
          {"name": "Exercise name", ${exerciseList.length > 0 ? '"exerciseId": "uuid-from-list",' : ''} "sets": 3, "reps": "8-12", "restSeconds": 90}
        ]
      }
    ]
  }${generateMeal ? ',' : ''}` : ''}
  ${generateMeal ? `"mealPlan": {
    "name": "plan name based on diet and goal",
    "dailyCalorieTarget": 0,
    "dailyProteinTarget": 0,
    "macroSplit": {"proteinPct": 40, "carbsPct": 30, "fatPct": 30},
    "days": [
      {
        "dayNumber": 1,
        "dayLabel": "Monday",
        "meals": [
          {"mealType": "breakfast", "name": "Meal name", "calories": 400, "proteinG": 35, "carbsG": 40, "fatG": 12, "instructions": "How to prepare"}
        ]
      }
    ]
  }` : ''}
}

CRITICAL: Return ONLY valid JSON, no markdown, no explanation, no code fences.

Rules:
${generateWorkout ? `- Create EXACTLY ${trainingDays} training days + ${7 - trainingDays} rest days = 7 total days
- Rest days have empty exercises array and dayName should include "Rest"
- Training split must match ${trainingDays} training days (e.g., 3 days = Push/Pull/Legs, 4 days = Upper/Lower split, 5-6 days = PPL or body part split)
- Volume and complexity must match ${experience_level || 'beginner'} level
  - Beginner: 3-4 exercises per day, 3 sets each
  - Intermediate: 4-5 exercises per day, 3-4 sets
  - Advanced: 5-6 exercises per day, 4-5 sets` : ''}
${generateMeal ? `- Calculate dailyCalorieTarget and dailyProteinTarget using the TDEE formula above — do NOT use placeholder values
- Create 7 meal plan days with 3 meals each (breakfast, lunch, dinner)
- Diet type is "${diet_type || 'omnivore'}" — only include appropriate foods
- If vegetarian/vegan, absolutely no meat/fish
- Each meal must have realistic calorie and macro values that sum to the daily targets
- Keep meal instructions to one sentence` : ''}`

  console.log(`[generate-plan] Sending prompt to GPT-4o (planType: ${planType})`)
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4000,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  })

  const rawContent = completion.choices[0].message.content
  console.log(`[generate-plan] GPT response received, length: ${rawContent ? rawContent.length : 0}`)

  let planData
  try {
    planData = JSON.parse(rawContent)
  } catch (parseError) {
    console.error('[generate-plan] Failed to parse GPT response as JSON:', rawContent?.substring(0, 500))
    throw new Error(`GPT returned invalid JSON: ${parseError.message}`)
  }

  // Save workout plan
  if (generateWorkout && planData.workoutPlan) {
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

    if (wpError) throw new Error(`Failed to save workout plan: ${wpError.message}`)
    console.log(`[generate-plan] Saved workout plan: ${workoutPlan.id}`)

    for (const day of planData.workoutPlan.days) {
      const { data: workoutDay, error: wdError } = await supabase
        .from('workout_days')
        .insert({
          plan_id: workoutPlan.id,
          day_number: day.dayNumber,
          day_name: day.dayName,
          muscle_groups: day.muscleGroups || [],
        })
        .select()
        .single()

      if (wdError) {
        console.error(`Failed to save workout day ${day.dayNumber}:`, wdError.message)
        continue
      }

      if (workoutDay && day.exercises?.length > 0) {
        for (let i = 0; i < day.exercises.length; i++) {
          const ex = day.exercises[i]
          let exerciseId = null

          // Use the exerciseId from GPT if it references a real exercise
          if (ex.exerciseId) {
            const { data: existing } = await supabase
              .from('exercises')
              .select('id')
              .eq('id', ex.exerciseId)
              .single()
            if (existing) exerciseId = existing.id
          }

          // Fallback: find by name
          if (!exerciseId) {
            const { data: byName } = await supabase
              .from('exercises')
              .select('id')
              .ilike('name', ex.name)
              .limit(1)
              .single()
            if (byName) exerciseId = byName.id
          }

          // Last resort: create the exercise
          if (!exerciseId) {
            const { data: newEx } = await supabase
              .from('exercises')
              .insert({ name: ex.name, is_custom: false })
              .select()
              .single()
            if (newEx) exerciseId = newEx.id
          }

          if (exerciseId) {
            const { error: wdeError } = await supabase.from('workout_day_exercises').insert({
              workout_day_id: workoutDay.id,
              exercise_id: exerciseId,
              order_index: i,
              sets: ex.sets || 3,
              reps: String(ex.reps || '8-12'),
              rest_seconds: ex.restSeconds || 90,
            })
            if (wdeError) console.error(`Failed to save exercise ${ex.name}:`, wdeError.message)
          }
        }
      }
    }
  }

  // Save meal plan
  if (generateMeal && planData.mealPlan) {
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

    if (mpError) throw new Error(`Failed to save meal plan: ${mpError.message}`)
    console.log(`[generate-plan] Saved meal plan: ${mealPlan.id}`)

    for (const day of planData.mealPlan.days) {
      const { data: planDay, error: pdError } = await supabase
        .from('meal_plan_days')
        .insert({
          plan_id: mealPlan.id,
          day_number: day.dayNumber,
          day_label: day.dayLabel,
        })
        .select()
        .single()

      if (pdError) {
        console.error(`Failed to save meal plan day ${day.dayNumber}:`, pdError.message)
        continue
      }

      if (planDay && day.meals?.length > 0) {
        for (const meal of day.meals) {
          const { error: mealError } = await supabase.from('meals').insert({
            plan_day_id: planDay.id,
            meal_type: meal.mealType,
            name: meal.name,
            calories: meal.calories,
            protein_g: meal.proteinG,
            carbs_g: meal.carbsG,
            fat_g: meal.fatG,
            instructions: meal.instructions || '',
          })
          if (mealError) console.error(`Failed to save meal ${meal.name}:`, mealError.message)
        }
      }
    }
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`FitTrack API v2 running on port ${PORT}`))
