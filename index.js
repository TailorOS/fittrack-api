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
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
if (!process.env.SUPABASE_SERVICE_KEY) {
  console.warn('WARNING: SUPABASE_SERVICE_KEY not set, falling back to SUPABASE_ANON_KEY — RLS will block updates!')
} else {
  console.log('Supabase initialized with SERVICE_KEY (RLS bypassed)')
}
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey)

// Root health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FitTrack API v2', timestamp: new Date().toISOString() })
})

// =============================================
// VALUE COERCION — Ensure correct types for Supabase columns
// =============================================
function coerceValue(field, value) {
  const floatFields = ['weight', 'body_fat_percentage', 'muscle_mass']
  const intFields = ['age', 'training_days_per_week']

  if (floatFields.includes(field)) return parseFloat(value)
  if (intFields.includes(field)) return parseInt(value, 10)

  // Normalize goal values — GPT sometimes uses wrong format
  if (field === 'goal') {
    const v = String(value).toLowerCase().replace(/[^a-z_]/g, '')
    if (v.includes('lose') || v.includes('fat') || v.includes('weight') || v.includes('cut')) return 'lose_fat'
    if (v.includes('lean')) return 'lean_muscle'
    if (v.includes('build') || v.includes('bulk') || v.includes('gain')) return 'build_muscle'
    if (v.includes('maintain')) return 'maintain'
    if (v.includes('perform') || v.includes('endur')) return 'performance'
    return value // fallback to whatever was sent
  }

  return value
}

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
  const updateValue = coerceValue(field, value)

  console.log(`[executeUpdateProfile] Updating profiles.${field} = ${JSON.stringify(updateValue)} (type: ${typeof updateValue}) for id=${userId}`)

  const { data, error } = await supabase
    .from('profiles')
    .update({ [field]: updateValue })
    .eq('id', userId)
    .select()

  console.log('[executeUpdateProfile] Result:', JSON.stringify({ data, error }))

  if (error) throw new Error(`Failed to update profile: ${error.message}`)
  if (!data || data.length === 0) throw new Error(`No profile found for userId: ${userId}`)
  return { success: true, field, value: updateValue, updated: data[0] }
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
    const { message, userId, profileSnapshot, conversationHistory, imageBase64 } = req.body

    if ((!message && !imageBase64) || !userId) {
      return res.status(400).json({ error: 'message (or imageBase64) and userId are required' })
    }

    const p = profileSnapshot || {}
    const name = p.name || 'there'
    const systemPrompt = `You are ${name}'s personal AI fitness and nutrition coach. You have full knowledge of their stats and goals. Be specific, personal, and actionable — never generic.

CLIENT PROFILE:
- Name: ${name} | Age: ${p.age || 'unknown'} | Gender: ${p.gender || 'unknown'}
- Weight: ${p.weight ? p.weight + ' lbs' : 'unknown'} | Height: ${p.height || 'unknown'}
- Goal: ${p.goal || 'unknown'} | Experience: ${p.experienceLevel || 'unknown'}
- Activity: ${p.activityLevel || 'unknown'} | Training: ${p.trainingDaysPerWeek || 'unknown'} days/week
- Diet/Cuisine: ${p.dietType || 'unknown'}

YOUR CAPABILITIES:
1. Give workout advice tailored to their experience, goal, and available equipment (home or gym)
2. Give nutrition advice based on their diet type and cuisine preference (e.g. Indian home-cooked meals)
3. Answer any fitness/health question using their specific stats
4. Update their profile when they share new info
5. Log body composition when they share measurements
6. Generate new workout or meal plans on request

When user mentions multiple stats at once (e.g. "I'm male, 24, 5'9, 135lbs"), call ALL relevant update_profile tools in PARALLEL in a single response. Use multiple tool_calls in one response — do NOT call them one at a time.

When taking an action: state it briefly in ONE sentence (under 12 words). Do NOT ask for confirmation — the app handles that automatically. Example: "Updating your weight to 135 lbs."

For goal updates, ALWAYS use these exact values for the 'value' field:
- Lose fat / lose weight / cut = "lose_fat"
- Build muscle / gain muscle = "build_muscle"
- Lean muscle / lean bulk = "lean_muscle"
- Maintain / maintenance = "maintain"
- Performance / endurance = "performance"
Never use values like "losing_weight", "gaining_muscle", "weight_loss" — only use the exact values above.

For advice: be specific to THEIR stats. Reference their weight, goal, experience level. E.g. if they ask about protein, calculate based on their actual weight. If they ask about home workouts, give bodyweight routines. If they mention their mom cooks Indian food, suggest specific Indian dishes that fit their macros.

Tone: Encouraging, direct, like a knowledgeable friend. 2-3 sentences max unless they ask for detail.

If the user sends a meal photo:
- Identify all food items visible
- Estimate calories and macros (protein, carbs, fat) for each item
- Give total calories and macros
- Tell them if this fits their daily targets based on their profile
- Suggest any adjustments or alternatives from their cuisine preference
- Format response clearly: food items listed, then totals

If the user sends gym equipment/home gym photo:
- Identify all equipment visible
- List what muscle groups can be trained
- Offer to generate a workout plan using only that equipment
- Be specific about what exercises are possible

Always respond as their personal trainer, referencing their goals and profile.`

    const messages = [{ role: 'system', content: systemPrompt }]

    // Include conversation history if provided
    if (Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory.slice(-10)) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    if (imageBase64) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: 'low'
            }
          },
          {
            type: 'text',
            text: message || 'What is in this image? Analyze it as my fitness trainer.'
          }
        ]
      })
    } else {
      messages.push({ role: 'user', content: message })
    }

    // First call — may return tool calls
    let completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: chatTools,
      tool_choice: 'auto',
      parallel_tool_calls: true, // allow multiple updates in one response
      max_tokens: 500,
      temperature: 0.7,
    }, { timeout: 60000 })

    let assistantMessage = completion.choices[0].message

    // If GPT wants to call tools, batch ALL updates into one pendingAction
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const allCalls = assistantMessage.tool_calls.map(tc => ({
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments)
      }))

      // Build a single batched pendingAction with all updates
      const updates = []
      const pendingAction = { type: 'batch_update', updates: [] }

      for (const { name, args } of allCalls) {
        if (name === 'update_profile') {
          pendingAction.updates.push({ type: 'profile_updated', field: args.field, value: args.value })
          const fieldLabels = { weight: 'Weight', goal: 'Goal', age: 'Age', height: 'Height', gender: 'Gender', training_days_per_week: 'Training days', diet_type: 'Diet', experience_level: 'Experience', activity_level: 'Activity level' }
          updates.push(`${fieldLabels[args.field] || args.field}: ${args.value}`)
        } else if (name === 'log_body_composition') {
          pendingAction.updates.push({ type: 'composition_logged', ...args })
          if (args.weight) updates.push(`Weight: ${args.weight} lbs`)
          if (args.body_fat_percentage) updates.push(`Body fat: ${args.body_fat_percentage}%`)
          if (args.muscle_mass) updates.push(`Muscle mass: ${args.muscle_mass} lbs`)
        } else if (name === 'regenerate_plan') {
          pendingAction.updates.push({ type: 'plan_regenerated', planType: args.plan_type })
          updates.push(`Generate new ${args.plan_type} plan`)
        }
      }

      // Single action message summarizing everything
      const actionMessage = updates.length === 1
        ? `Updating your ${updates[0].toLowerCase()}.`
        : `Updating ${updates.length} things: ${updates.join(', ')}.`

      return res.json({ message: actionMessage, pendingAction })
    }

    res.json({ message: assistantMessage.content })
  } catch (error) {
    console.error('Chat error:', error)
    res.status(500).json({ error: 'Chat failed. Please try again.' })
  }
})

// =============================================
// ACTION STATEMENT — Clean statement for confirm card (no questions)
// =============================================
function generateActionStatement(toolName, toolArgs) {
  if (toolName === 'update_profile') {
    const fieldLabels = {
      weight: `weight to ${toolArgs.value} lbs`,
      goal: `goal to "${toolArgs.value}"`,
      training_days_per_week: `training days to ${toolArgs.value} per week`,
      diet_type: `diet preference to ${toolArgs.value}`,
      experience_level: `experience level to ${toolArgs.value}`,
      activity_level: `activity level to ${toolArgs.value}`,
      age: `age to ${toolArgs.value}`,
      height: `height to ${toolArgs.value}`,
    }
    return `Updating your ${fieldLabels[toolArgs.field] || toolArgs.field}.`
  }
  if (toolName === 'log_body_composition') {
    const parts = []
    if (toolArgs.weight) parts.push(`weight: ${toolArgs.weight} lbs`)
    if (toolArgs.body_fat_percentage) parts.push(`body fat: ${toolArgs.body_fat_percentage}%`)
    if (toolArgs.muscle_mass) parts.push(`muscle mass: ${toolArgs.muscle_mass} lbs`)
    return `Logging your measurements — ${parts.join(', ')}.`
  }
  if (toolName === 'regenerate_plan') {
    const planLabels = { workout: 'workout plan', meal: 'meal plan', both: 'workout and meal plan' }
    return `Generating a new ${planLabels[toolArgs.plan_type] || 'plan'} based on your profile.`
  }
  return 'Ready to update your profile.'
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

  console.log('[execute-action] Received:', JSON.stringify({ userId, action }))

  if (!userId || !action) {
    return res.status(400).json({ error: 'userId and action required' })
  }

  try {
    // Handle batch updates (multiple fields at once)
    if (action.type === 'batch_update' && Array.isArray(action.updates)) {
      console.log(`[execute-action] Batch update: ${action.updates.length} items`)
      const results = []
      
      // Collect all profile field updates into one Supabase call
      const profileUpdates = {}
      const otherUpdates = []
      
      for (const update of action.updates) {
        if (update.type === 'profile_updated') {
          profileUpdates[update.field] = coerceValue(update.field, update.value)
        } else {
          otherUpdates.push(update)
        }
      }
      
      // Single profile update call for all field changes
      if (Object.keys(profileUpdates).length > 0) {
        console.log('[execute-action] Batch profile update:', JSON.stringify(profileUpdates))
        const { error } = await supabase.from('profiles').update(profileUpdates).eq('id', userId)
        if (error) throw new Error(error.message)
        results.push(`Updated: ${Object.keys(profileUpdates).join(', ')}`)
      }
      
      // Handle other update types
      for (const update of otherUpdates) {
        if (update.type === 'composition_logged') {
          const logData = { user_id: userId, logged_at: new Date().toISOString() }
          if (update.weight != null) logData.weight = parseFloat(update.weight)
          if (update.body_fat_percentage != null) logData.body_fat_percentage = parseFloat(update.body_fat_percentage)
          if (update.muscle_mass != null) logData.muscle_mass = parseFloat(update.muscle_mass)
          const { error } = await supabase.from('body_composition_logs').insert(logData)
          if (error) throw new Error(error.message)
          results.push('Body composition logged')
        }
      }
      
      const fieldLabels = { weight: 'weight', goal: 'goal', age: 'age', height: 'height', gender: 'gender', training_days_per_week: 'training days', diet_type: 'diet', experience_level: 'experience', activity_level: 'activity level' }
      const updatedFields = Object.keys(profileUpdates).map(f => fieldLabels[f] || f)
      const message = updatedFields.length === 1
        ? `Done! Updated your ${updatedFields[0]}.`
        : `Done! Updated your ${updatedFields.slice(0, -1).join(', ')} and ${updatedFields[updatedFields.length - 1]}.`
      
      return res.json({ success: true, message })
    }

    switch (action.type) {
      case 'profile_updated': {
        const coercedValue = coerceValue(action.field, action.value)
        console.log(`[execute-action] Updating profiles.${action.field} = ${JSON.stringify(coercedValue)} for id=${userId}`)

        const { data, error } = await supabase
          .from('profiles')
          .update({ [action.field]: coercedValue })
          .eq('id', userId)
          .select()

        console.log('[execute-action] Update result - data:', JSON.stringify(data), 'error:', JSON.stringify(error))

        if (error) {
          console.error('[execute-action] Supabase error:', error.message)
          return res.status(500).json({ error: error.message })
        }
        if (!data || data.length === 0) {
          console.error('[execute-action] No rows updated - userId:', userId)
          return res.status(404).json({ error: 'Profile not found for this user' })
        }

        return res.json({
          success: true,
          message: getUpdateConfirmation(action.field, action.value),
          updated: data[0]
        })
      }

      case 'composition_logged': {
        const logData = {
          user_id: userId,
          logged_at: new Date().toISOString()
        }
        if (action.weight != null) logData.weight = parseFloat(action.weight)
        if (action.body_fat_percentage != null) logData.body_fat_percentage = parseFloat(action.body_fat_percentage)
        if (action.muscle_mass != null) logData.muscle_mass = parseFloat(action.muscle_mass)

        console.log('[execute-action] Logging body composition:', JSON.stringify(logData))

        const { data, error } = await supabase
          .from('body_composition_logs')
          .insert(logData)
          .select()

        console.log('[execute-action] Insert result - data:', JSON.stringify(data), 'error:', JSON.stringify(error))

        if (error) {
          console.error('[execute-action] Supabase error:', error.message)
          return res.status(500).json({ error: error.message })
        }

        return res.json({
          success: true,
          message: 'Logged! Your progress has been recorded.'
        })
      }

      case 'plan_regenerated': {
        const planType = action.planType || 'both'
        console.log(`[execute-action] Regenerating ${planType} plan for userId:`, userId)

        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single()

        if (profileError || !profile) {
          console.error('[execute-action] Profile fetch error:', profileError?.message)
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
        return res.json({
          success: true,
          message: `Done! Your new ${planType === 'both' ? 'workout and meal plans have' : planType + ' plan has'} been generated. Check the ${planType === 'meal' ? 'Nutrition' : 'Workout'} tab.`
        })
      }

      default:
        return res.status(400).json({ error: `Unknown action type: ${action.type}` })
    }
  } catch (error) {
    console.error('[execute-action] ERROR:', error.message)
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

  // Pre-calculate accurate macros server-side so GPT just uses the numbers
  const weightKg = Math.round((weight || 150) * 0.453592)
  const heightCmNum = (() => {
    if (!height) return 175
    const m = String(height).match(/(\d+)'(\d+)/)
    if (m) return Math.round((parseInt(m[1]) * 12 + parseInt(m[2])) * 2.54)
    return parseFloat(height) || 175
  })()
  const ageNum = age || 25
  const genderStr = (gender || 'male').toLowerCase()

  // BMR — Mifflin-St Jeor
  const bmr = genderStr === 'female'
    ? (10 * weightKg) + (6.25 * heightCmNum) - (5 * ageNum) - 161
    : (10 * weightKg) + (6.25 * heightCmNum) - (5 * ageNum) + 5

  // Activity multiplier
  const activityMap = {
    sedentary: 1.2, lightly_active: 1.375, light: 1.375,
    moderately_active: 1.55, moderate: 1.55, active: 1.55,
    very_active: 1.725, athlete: 1.9, extremely_active: 1.9
  }
  const activityKey = (activity_level || 'moderately_active').toLowerCase().replace(/ /g, '_')
  const actMultiplier = activityMap[activityKey] || 1.55
  const tdee = Math.round(bmr * actMultiplier)

  // Goal adjustment
  let targetCalories = tdee
  if (goal === 'build_muscle' || goal === 'lean_muscle') targetCalories = tdee + 250
  else if (goal === 'lose_fat' || goal === 'weight_loss') targetCalories = tdee - 400
  // Never go below 1500
  targetCalories = Math.max(targetCalories, 1500)

  // Protein: evidence-based — 0.8–1g per lb bodyweight (not % of calories)
  const weightLbs = weight || 150
  let proteinG = Math.round(weightLbs * 0.9) // 0.9g per lb — solid for most goals
  if (goal === 'build_muscle' || goal === 'lean_muscle') proteinG = Math.round(weightLbs * 1.0)
  else if (goal === 'lose_fat') proteinG = Math.round(weightLbs * 1.0) // higher protein preserves muscle on deficit

  // Remaining calories split between carbs and fat
  const proteinCals = proteinG * 4
  const remainingCals = targetCalories - proteinCals
  const fatG = Math.round((remainingCals * 0.30) / 9)  // 30% of remaining from fat
  const carbsG = Math.round((remainingCals * 0.70) / 4) // 70% of remaining from carbs

  const tdeeInstructions = `
PRE-CALCULATED NUTRITION TARGETS (use these EXACT numbers — do not recalculate):
- BMR: ${Math.round(bmr)} kcal
- TDEE (maintenance): ${tdee} kcal  
- Daily Calorie Target: ${targetCalories} kcal (adjusted for ${goal} goal)
- Daily Protein Target: ${proteinG}g (based on ${weightLbs} lbs bodyweight at 0.9-1.0g/lb — realistic and evidence-based)
- Daily Carbs Target: ${carbsG}g
- Daily Fat Target: ${fatG}g

These numbers are pre-calculated correctly. Use them directly for dailyCalorieTarget and dailyProteinTarget.
Do NOT override or recalculate these values.
`

  const generateWorkout = planType === 'workout' || planType === 'both'
  const generateMeal = planType === 'meal' || planType === 'both'

  // Always split workout and meal into separate GPT calls when generating both
  // This prevents JSON truncation (was the main cause of "invalid JSON" errors)
  if (planType === 'both') {
    await generateAndSavePlan(userId, profile, 'workout')
    await generateAndSavePlan(userId, profile, 'meal')
    return
  }

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
- CUISINE/DIET: "${diet_type || 'omnivore'}" — this is CRITICAL and MANDATORY:
  * If "Indian": ALL meals must be traditional Indian food (dal, sabzi, roti, rice, paneer, chicken curry, biryani, idli, dosa, etc). NO Western food at all.
  * If "Western": Use Western foods (chicken breast, salads, pasta, sandwiches, etc)
  * If "Mediterranean": Use Mediterranean foods (hummus, falafel, fish, olive oil, etc)
  * If "Asian": Use Asian foods (stir fry, noodles, rice bowls, sushi, etc)
  * If vegetarian/vegan: absolutely no meat or fish
  * Every single meal must match the cuisine preference above — do not mix cuisines
- Meal names must clearly reflect the cuisine (e.g. "Dal Tadka with Jeera Rice" not "Lentil Soup")
- Each meal must have realistic calorie and macro values that sum to the daily targets
- Keep meal instructions to one sentence` : ''}`

  console.log(`[generate-plan] Sending prompt to GPT-4o (planType: ${planType})`)
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8000, // 7-day workout + 7-day meal plan needs room — old 4000 was causing truncated JSON
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

// =============================================
// ANALYZE IMAGE — Dedicated vision endpoint for meal/equipment analysis
// =============================================
app.post('/api/analyze-image', async (req, res) => {
  const { userId, imageBase64, analysisType, profileSnapshot } = req.body

  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' })

  const p = profileSnapshot || {}

  let prompt = ''
  if (analysisType === 'meal') {
    prompt = `You are a nutrition expert and personal trainer for ${p.name || 'this user'}.

Their profile: Goal: ${p.goal}, Weight: ${p.weight}lbs, Diet: ${p.dietType}, Daily calorie target: ~${p.dailyCalories || 'unknown'}

Analyze this meal photo and provide:
1. List of food items identified with estimated portion sizes
2. Calories per item
3. Total: Calories, Protein (g), Carbs (g), Fat (g)
4. Whether this fits their goal (e.g. "Good protein source for muscle building" or "High in carbs, consider smaller portion")
5. One specific tip based on their diet preference

Format as JSON:
{
  "items": [{"name": "Dal", "portion": "1 cup", "calories": 180, "protein": 12, "carbs": 28, "fat": 4}],
  "totals": {"calories": 0, "protein": 0, "carbs": 0, "fat": 0},
  "assessment": "brief assessment string",
  "tip": "specific tip string"
}`
  } else if (analysisType === 'equipment') {
    prompt = `Identify all gym/fitness equipment visible in this image. List each piece with:
1. Equipment name
2. What muscle groups it trains
3. 3 key exercises possible with it

Return as JSON:
{
  "equipment": [{"name": "Dumbbells", "muscleGroups": ["biceps", "triceps", "shoulders"], "exercises": ["Bicep curl", "Overhead press", "Lateral raise"]}],
  "summary": "Brief summary of what full workout is possible with this setup"
}`
  } else {
    prompt = `Analyze this fitness-related image. Describe what you see and provide relevant fitness advice. Return as JSON:
{
  "description": "what is in the image",
  "advice": "relevant fitness advice"
}`
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 800,
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })

    const result = JSON.parse(completion.choices[0].message.content)
    res.json({ success: true, analysisType, result })
  } catch (error) {
    console.error('[analyze-image] Error:', error.message)
    res.status(500).json({ error: 'Image analysis failed' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`FitTrack API v2 running on port ${PORT}`))
