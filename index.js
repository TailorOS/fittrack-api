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
app.use(express.json({ limit: '10mb' })) // images sent as base64 need larger limit

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
  {
    type: 'function',
    function: {
      name: 'log_food',
      description: "Log a food/meal to the user's daily food diary when they confirm they want to add it. Use after analyzing a food photo or when user asks to log a specific food.",
      parameters: {
        type: 'object',
        properties: {
          food_name: { type: 'string', description: 'Name of the food or meal' },
          calories: { type: 'number', description: 'Estimated calories' },
          protein_g: { type: 'number', description: 'Protein in grams' },
          carbs_g: { type: 'number', description: 'Carbohydrates in grams' },
          fat_g: { type: 'number', description: 'Fat in grams' },
        },
        required: ['food_name', 'calories'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'modify_workout',
      description: `Modify or customize the user's workout plan. Use when user asks to:
- Replace an exercise ("swap squats with lunges", "replace bench press")
- Change sets/reps ("make pull day harder", "reduce volume")
- Change a workout day split ("change push day to chest and shoulders only")
- Add or remove exercises from a day
Always keep changes aligned with their goal and experience level. Warn if change reduces effectiveness.`,
      parameters: {
        type: 'object',
        properties: {
          day_name: {
            type: 'string',
            description: 'Name of the workout day to modify (e.g. "Push Day", "Pull Day", "Leg Day")'
          },
          action: {
            type: 'string',
            enum: ['replace_exercise', 'add_exercise', 'remove_exercise', 'change_sets_reps', 'rename_day'],
            description: 'What type of modification to make'
          },
          old_exercise_name: {
            type: 'string',
            description: 'Name of exercise to replace or remove (for replace_exercise/remove_exercise)'
          },
          new_exercise_name: {
            type: 'string',
            description: 'Name of the new or added exercise'
          },
          muscle_group: {
            type: 'string',
            description: 'Primary muscle group for the exercise'
          },
          equipment: {
            type: 'string',
            description: 'Equipment needed (barbell, dumbbell, bodyweight, cable, machine)'
          },
          sets: { type: 'number', description: 'Number of sets' },
          reps: { type: 'string', description: 'Rep range (e.g. "8-12", "5", "12-15")' },
          rest_seconds: { type: 'number', description: 'Rest time in seconds' },
        },
        required: ['day_name', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'modify_meal',
      description: `Modify or replace a specific meal in the user's current meal plan. Use when user asks to:
- Replace a meal ("swap my lunch", "replace breakfast with eggs")
- Customize a meal ("change dinner to chicken rice")
- Make a meal higher/lower protein/calorie
- Remove eggs, dairy, or specific ingredients from a meal
Always estimate accurate macros. Keep total daily calories close to their target.`,
      parameters: {
        type: 'object',
        properties: {
          meal_type: {
            type: 'string',
            enum: ['breakfast', 'lunch', 'dinner', 'snack'],
            description: 'Which meal to replace'
          },
          meal_name: { type: 'string', description: 'New meal name' },
          calories: { type: 'number', description: 'Calories for this meal' },
          protein_g: { type: 'number', description: 'Protein in grams' },
          carbs_g: { type: 'number', description: 'Carbs in grams' },
          fat_g: { type: 'number', description: 'Fat in grams' },
          instructions: { type: 'string', description: 'One-sentence preparation instruction with exact portions' },
        },
        required: ['meal_type', 'meal_name', 'calories', 'protein_g'],
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
  if (args.weight != null) {
    logEntry.weight_lbs = args.weight
  }
  if (args.body_fat_percentage != null) {
    logEntry.body_fat_pct = args.body_fat_percentage
  }
  if (args.muscle_mass != null) {
    logEntry.muscle_mass_lbs = args.muscle_mass
  }

  const todayDateStr = logEntry.logged_at.split('T')[0]
  logEntry.logged_at = todayDateStr  // Use date only for upsert conflict key
  const { data, error } = await supabase
    .from('body_composition_logs')
    .upsert(logEntry, { onConflict: 'user_id,logged_at' })
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
    const ts = p.todayStats || {}
    const name = p.name || 'there'
    
    // Fetch current plan info so AI knows what user already has
    let currentPlanContext = ''
    try {
      const [mealPlanRes, workoutPlanRes] = await Promise.all([
        supabase.from('meal_plans')
          .select('name, daily_calorie_target, daily_protein_target, meal_plan_days(day_number, meals(meal_type, name, calories, protein_g))')
          .eq('user_id', userId)
          .eq('is_active', true)
          .single(),
        supabase.from('workout_plans')
          .select('name, workout_days(day_name, day_number, workout_day_exercises(sets, reps, exercises(name, muscle_group)))')
          .eq('user_id', userId)
          .eq('is_active', true)
          .single()
      ])
      
      if (mealPlanRes.data) {
        const mp = mealPlanRes.data
        const todayDayNum = new Date(req.body?.todayStr ? req.body.todayStr + 'T12:00:00Z' : Date.now()).getUTCDay() || 7
        const todayMeals = mp.meal_plan_days?.find(d => d.day_number === todayDayNum)?.meals || []
        currentPlanContext += `
CURRENT MEAL PLAN: "${mp.name}" (${mp.daily_calorie_target} kcal, ${mp.daily_protein_target}g protein target)
Today's meals: ${todayMeals.map(m => `${m.meal_type}: ${m.name} (${m.calories} kcal, ${m.protein_g}g protein)`).join(' | ')}
`
      }
      
      if (workoutPlanRes.data) {
        const wp = workoutPlanRes.data
        const todayDayNum2 = new Date(req.body?.todayStr ? req.body.todayStr + 'T12:00:00Z' : Date.now()).getUTCDay() || 7
        const todayWorkout = wp.workout_days?.find(d => d.day_number === todayDayNum2)
        currentPlanContext += `
CURRENT WORKOUT PLAN: "${wp.name}"
Today's workout: ${todayWorkout ? `${todayWorkout.day_name} — ${todayWorkout.workout_day_exercises?.map(e => e.exercises?.name + ' ' + e.sets + 'x' + e.reps).join(', ')}` : 'Rest day'}
`
      }
    } catch (e) {
      console.log('[chat] Could not fetch plan context:', e.message)
    }
    
    // Build today's summary string from live data
    const todaySummary = ts.calTarget ? `
TODAY'S LIVE DATA (real-time, use these exact numbers when asked):
- Score: ${ts.score || 0}/100
- Calories consumed: ${ts.calConsumed || 0} / ${ts.calTarget} kcal (${Math.round(((ts.calConsumed || 0) / (ts.calTarget || 1)) * 100)}% of target)
- Protein consumed: ${ts.proteinConsumed || 0}g / ${ts.proteinTarget || 0}g (${ts.proteinConsumed >= ts.proteinTarget ? 'TARGET HIT ✓' : (ts.proteinTarget - ts.proteinConsumed) + 'g remaining'})
- Workout: ${ts.workoutDone ? 'COMPLETED ✓' : 'Not done yet'}
- Weight logged today: ${ts.bodyCompLogged ? 'YES ✓' : 'Not logged yet'}
- Meals confirmed: ${ts.confirmedCount || 0} of ${ts.totalMeals || 0} plan meals` : ''
    
    const systemPrompt = `You are ${name}'s personal AI fitness and nutrition coach. You have full knowledge of their stats and goals. Be specific, personal, and actionable — never generic.

CLIENT PROFILE:
- Name: ${name} | Age: ${p.age || 'unknown'} | Gender: ${p.gender || 'unknown'}
- Weight: ${p.weight ? p.weight + ' lbs' : 'unknown'} | Height: ${p.height || 'unknown'}
- Goal: ${p.goal || 'unknown'} | Experience: ${p.experienceLevel || 'unknown'}
- Activity: ${p.activityLevel || 'unknown'} | Training: ${p.trainingDaysPerWeek || 'unknown'} days/week
- Diet/Cuisine: ${p.dietType || 'unknown'}
- Protein target from plan: ${ts.proteinTarget ? ts.proteinTarget + 'g/day' : 'see profile weight × 1g/lb'}
- Calorie target from plan: ${ts.calTarget ? ts.calTarget + ' kcal/day' : 'calculated from TDEE'}
${todaySummary}
${currentPlanContext}

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

RESPONSE STYLE — Very important:
- Use emojis naturally (💪 🔥 🥗 ⚖️ 📊 ✅) to make responses feel motivating and alive
- Never end with a question like "Would you like me to..." — just be direct and helpful
- When celebrating wins: be enthusiastic! "That's a solid day 🔥" not just "good job"
- When correcting gaps: be specific and constructive, not preachy
- Keep responses under 150 words unless detail is truly needed
- Format with line breaks between topics for readability

IF USER SENDS A MEAL/FOOD PHOTO:
- List each food item with emoji, portion estimate, and macros
- Give totals: calories, protein, carbs, fat
- Tell them if it fits today's remaining targets
- Suggest one improvement if applicable
- Offer to log it: "Want me to add this to your log?"

IF USER SENDS A BODY PHOTO (selfie, physique, body fat check):
- Estimate body fat % based on visible muscle definition, vascularity, and body fat distribution
- Note muscle development in key areas visible
- Give specific feedback for their goal (${p.goal || 'fitness'})
- If body fat estimate is clear, offer to log it: call log_body_composition with estimated body_fat_percentage
- Be encouraging and specific: "Your core development is solid, work on shoulder width"

IF USER SENDS GYM/EQUIPMENT PHOTO:
- List ALL equipment visible with their use cases
- Suggest 3-4 exercises possible with that setup
- Offer to generate a custom workout plan for that equipment



GOAL-AWARE COACHING RULES — You are a smart coach, not a yes-machine:

Goal context: goal=${p.goal || 'unknown'}, target=${ts.calTarget || '?'} kcal, protein=${ts.proteinTarget || '?'}g

BEFORE executing any meal change:
- If replacement adds >200 kcal AND goal is lose_fat: warn the user with exact numbers, suggest a better alternative, but still offer to proceed if they insist
- If replacement drops protein significantly AND goal is build_muscle/lean_muscle: flag it and suggest adding a protein source
- If the request fits their goal perfectly: execute and explain why in 1 line

WHEN GIVING ADVICE:
- Always use their exact numbers — never generic ranges
- If advice conflicts with their goal: say so clearly, give the better alternative
- If they ask about off-plan food: tell them exactly how it fits with calories and protein remaining

WORKOUT MODIFICATION RULES:
- If user asks to remove a compound lift (squat, deadlift, bench, row) AND they have a muscle/strength goal → warn: "That's one of your most effective exercises for [goal]. How about reducing sets instead?" Then offer to proceed.
- If user asks to add an exercise that targets a muscle they already have 3+ exercises for → note it: "You already have 3 back exercises — this would make 4. Good for intensity focus, but watch recovery."
- If user asks to reduce volume below 2 exercises per day → warn: "That might not be enough stimulus for progress. Minimum 3 exercises keeps results coming."
- If change FITS their goal well → confirm and explain: "Good add — [exercise] hits [muscle] which supports your [goal] goal directly 💪"
- Always keep exercise names standard and searchable (e.g. "Barbell Row" not "bent over rows")

ALWAYS add 1-line context after actions:
- 'This keeps you at Xg protein for today ✅'
- 'This adds X kcal — you'll be Y kcal over target'
- 'This does not match your Indian cuisine preference — want me to adjust?'

Be the coach who cares enough to push back, but stay respectful and specific — never preachy.

Always respond as their dedicated personal trainer who knows them deeply.`

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
        } else if (name === 'log_food') {
          pendingAction.updates.push({ type: 'food_logged', ...args })
          updates.push(`Log ${args.food_name} (${args.calories} kcal, ${args.protein_g || 0}g protein)`)
        } else if (name === 'modify_meal') {
          pendingAction.updates.push({ type: 'meal_modified', ...args })
          const mealLabel = args.meal_type.charAt(0).toUpperCase() + args.meal_type.slice(1)
          updates.push(`Replace ${mealLabel}: ${args.meal_name} (${args.calories} kcal, ${args.protein_g}g protein)`)
        } else if (name === 'modify_workout') {
          pendingAction.updates.push({ type: 'workout_modified', ...args })
          const actionLabels = {
            replace_exercise: `${args.day_name}: Replace ${args.old_exercise_name || 'exercise'} with ${args.new_exercise_name}`,
            add_exercise: `${args.day_name}: Add ${args.new_exercise_name} (${args.sets || 3}×${args.reps || '10-12'})`,
            remove_exercise: `${args.day_name}: Remove ${args.old_exercise_name}`,
            change_sets_reps: `${args.day_name}: Change ${args.old_exercise_name || 'exercise'} to ${args.sets}×${args.reps}`,
            rename_day: `Rename to ${args.new_exercise_name}`,
          }
          updates.push(actionLabels[args.action] || `Modify ${args.day_name}`)
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
// RECALCULATE PLAN TARGETS — Updates calorie/protein targets when profile changes
// Does NOT regenerate meals — just updates the daily_calorie_target and daily_protein_target
// =============================================
async function recalculatePlanTargets(userId, profile) {
  const weight = profile.weight || 150
  const age = profile.age || 25
  const gender = (profile.gender || 'male').toLowerCase()
  const goal = profile.goal || 'maintain'
  const activityLevel = (profile.activity_level || 'moderately_active').toLowerCase().replace(/ /g, '_')

  // Parse height
  const heightStr = String(profile.height || "5'10")
  const m = heightStr.match(/(\d+)'(\d+)/)
  const heightCm = m ? Math.round((parseInt(m[1]) * 12 + parseInt(m[2])) * 2.54) : 175
  const weightKg = Math.round(weight * 0.453592)

  // BMR — Mifflin-St Jeor
  const bmr = gender === 'female'
    ? (10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161
    : (10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5

  const activityMap = {
    sedentary: 1.2, lightly_active: 1.375, light: 1.375,
    moderately_active: 1.55, moderate: 1.55, active: 1.55,
    very_active: 1.725, athlete: 1.9, extremely_active: 1.9
  }
  const tdee = Math.round(bmr * (activityMap[activityLevel] || 1.55))

  let targetCalories = tdee
  if (goal === 'build_muscle' || goal === 'lean_muscle') targetCalories = tdee + 250
  else if (goal === 'lose_fat' || goal === 'weight_loss') targetCalories = tdee - 400
  targetCalories = Math.max(targetCalories, 1500)

  let proteinG = Math.round(weight * 0.9)
  if (goal === 'build_muscle' || goal === 'lean_muscle') proteinG = Math.round(weight * 1.0)
  else if (goal === 'lose_fat') proteinG = Math.round(weight * 1.0)

  // Update active meal plan targets
  const { error } = await supabase
    .from('meal_plans')
    .update({
      daily_calorie_target: targetCalories,
      daily_protein_target: proteinG,
    })
    .eq('user_id', userId)
    .eq('is_active', true)

  if (error) console.error('[recalculatePlanTargets] Error:', error.message)
  else console.log(`[recalculatePlanTargets] Updated: ${targetCalories} kcal, ${proteinG}g protein for goal=${goal}`)

  return { targetCalories, proteinG }
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
        // If weight was in the batch, also write to body_composition_logs
        if (profileUpdates.weight != null) {
          const todayStr = new Date().toISOString().split('T')[0]
          await supabase.from('body_composition_logs').upsert({
            user_id: userId,
            logged_at: todayStr,
            weight_lbs: parseFloat(profileUpdates.weight),
          }, { onConflict: 'user_id,logged_at' })
        }
      }
      
      // Handle other update types
      for (const update of otherUpdates) {
        if (update.type === 'food_logged') {
          // Pass food data back to app — app saves to AsyncStorage
          results.push(`food_logged:${JSON.stringify({
            food_name: update.food_name,
            calories: update.calories || 0,
            protein_g: update.protein_g || 0,
            carbs_g: update.carbs_g || 0,
            fat_g: update.fat_g || 0,
          })}`)
        } else if (update.type === 'meal_modified') {
          // Update the meal in Supabase meal_plan_days/meals tables
          try {
            // Find active meal plan
            const { data: mealPlan } = await supabase
              .from('meal_plans')
              .select('id, meal_plan_days(id, day_number, meals(id, meal_type, name))')
              .eq('user_id', userId)
              .eq('is_active', true)
              .single()

            if (mealPlan) {
              // Use todayStr from request body (user's local timezone) not server UTC
              // Server is UTC — user may be in a different day entirely
              const userTodayStr = req.body?.todayStr || new Date().toISOString().split('T')[0]
              const userDate = new Date(userTodayStr + 'T12:00:00Z') // noon UTC to avoid edge cases
              const todayDayNum = userDate.getUTCDay() === 0 ? 7 : userDate.getUTCDay()
              console.log(`[modify_meal] User today: ${userTodayStr}, dayNum: ${todayDayNum}`)
              const todayDay = mealPlan.meal_plan_days?.find(d => d.day_number === todayDayNum)

              if (todayDay) {
                // Find the meal with matching meal_type
                const targetMeal = todayDay.meals?.find(m =>
                  m.meal_type?.toLowerCase() === update.meal_type?.toLowerCase()
                )

                if (targetMeal) {
                  // Update existing meal
                  const { error: updateErr } = await supabase
                    .from('meals')
                    .update({
                      name: update.meal_name,
                      calories: Math.round(update.calories),
                      protein_g: Math.round(update.protein_g || 0),
                      carbs_g: Math.round(update.carbs_g || 0),
                      fat_g: Math.round(update.fat_g || 0),
                      instructions: update.instructions || '',
                    })
                    .eq('id', targetMeal.id)

                  if (updateErr) throw new Error(updateErr.message)
                  console.log(`[execute-action] Updated meal ${targetMeal.id}: ${update.meal_name}`)
                } else {
                  // No matching meal type — insert new one
                  const { error: insertErr } = await supabase
                    .from('meals')
                    .insert({
                      plan_day_id: todayDay.id,
                      meal_type: update.meal_type,
                      name: update.meal_name,
                      calories: Math.round(update.calories),
                      protein_g: Math.round(update.protein_g || 0),
                      carbs_g: Math.round(update.carbs_g || 0),
                      fat_g: Math.round(update.fat_g || 0),
                      instructions: update.instructions || '',
                    })
                  if (insertErr) throw new Error(insertErr.message)
                  console.log(`[execute-action] Inserted new ${update.meal_type} meal for today`)
                }

                // Also clear today's confirmed status for this meal type (since it's been replaced)
                // Use userTodayStr (user's local date) not server UTC
                const { data: nutritionLog } = await supabase
                  .from('daily_nutrition_logs')
                  .select('confirmed_meal_ids')
                  .eq('user_id', userId)
                  .eq('logged_date', userTodayStr)
                  .single()

                if (nutritionLog && targetMeal) {
                  const filtered = (nutritionLog.confirmed_meal_ids || []).filter(id => id !== targetMeal.id)
                  await supabase
                    .from('daily_nutrition_logs')
                    .update({ confirmed_meal_ids: filtered })
                    .eq('user_id', userId)
                    .eq('logged_date', userTodayStr)
                }

                results.push(`meal_modified:${JSON.stringify({ meal_type: update.meal_type, meal_name: update.meal_name, calories: update.calories, protein_g: update.protein_g })}`)
              }
            }
          } catch (e) {
            console.error('[execute-action] meal_modified error:', e.message)
            results.push('meal_modified_error')
          }
        } else if (update.type === 'workout_modified') {
          try {
            // Find active workout plan
            const { data: workoutPlan } = await supabase
              .from('workout_plans')
              .select('id, workout_days(id, day_name, workout_day_exercises(id, order_index, sets, reps, rest_seconds, exercises(id, name, muscle_group, equipment)))')
              .eq('user_id', userId)
              .eq('is_active', true)
              .single()

            if (workoutPlan) {
              // Find the matching workout day
              const targetDay = workoutPlan.workout_days?.find(d =>
                d.day_name?.toLowerCase().includes(update.day_name?.toLowerCase()) ||
                update.day_name?.toLowerCase().includes(d.day_name?.toLowerCase().split(' ')[0])
              )

              if (targetDay) {
                if (update.action === 'replace_exercise' && update.old_exercise_name && update.new_exercise_name) {
                  // Find or create the new exercise
                  let { data: newEx } = await supabase.from('exercises').select('id').ilike('name', `%${update.new_exercise_name}%`).limit(1).single()
                  if (!newEx) {
                    const { data: created } = await supabase.from('exercises').insert({
                      name: update.new_exercise_name,
                      muscle_group: update.muscle_group || 'general',
                      equipment: update.equipment || 'bodyweight',
                    }).select().single()
                    newEx = created
                  }
                  if (newEx) {
                    // Find the workout_day_exercise to update
                    const targetEx = targetDay.workout_day_exercises?.find(e =>
                      e.exercises?.name?.toLowerCase().includes(update.old_exercise_name.toLowerCase())
                    )
                    if (targetEx) {
                      await supabase.from('workout_day_exercises').update({
                        exercise_id: newEx.id,
                        sets: update.sets || targetEx.sets,
                        reps: update.reps || targetEx.reps,
                        rest_seconds: update.rest_seconds || targetEx.rest_seconds,
                      }).eq('id', targetEx.id)
                      results.push('workout_modified:replaced ' + update.old_exercise_name + ' with ' + update.new_exercise_name + ' on ' + update.day_name)
                    }
                  }
                } else if (update.action === 'add_exercise' && update.new_exercise_name) {
                  let { data: newEx } = await supabase.from('exercises').select('id').ilike('name', `%${update.new_exercise_name}%`).limit(1).single()
                  if (!newEx) {
                    const { data: created } = await supabase.from('exercises').insert({
                      name: update.new_exercise_name,
                      muscle_group: update.muscle_group || 'general',
                      equipment: update.equipment || 'bodyweight',
                    }).select().single()
                    newEx = created
                  }
                  if (newEx) {
                    const maxOrder = Math.max(0, ...(targetDay.workout_day_exercises?.map(e => e.order_index) || [0]))
                    await supabase.from('workout_day_exercises').insert({
                      workout_day_id: targetDay.id,
                      exercise_id: newEx.id,
                      order_index: maxOrder + 1,
                      sets: update.sets || 3,
                      reps: update.reps || '10-12',
                      rest_seconds: update.rest_seconds || 90,
                    })
                    results.push('workout_modified:added ' + update.new_exercise_name + ' to ' + update.day_name)
                  }
                } else if (update.action === 'remove_exercise' && update.old_exercise_name) {
                  const targetEx = targetDay.workout_day_exercises?.find(e =>
                    e.exercises?.name?.toLowerCase().includes(update.old_exercise_name.toLowerCase())
                  )
                  if (targetEx) {
                    await supabase.from('workout_day_exercises').delete().eq('id', targetEx.id)
                    results.push('workout_modified:removed ' + update.old_exercise_name + ' from ' + update.day_name)
                  }
                } else if (update.action === 'change_sets_reps' && update.old_exercise_name) {
                  const targetEx = targetDay.workout_day_exercises?.find(e =>
                    e.exercises?.name?.toLowerCase().includes(update.old_exercise_name.toLowerCase())
                  )
                  if (targetEx) {
                    await supabase.from('workout_day_exercises').update({
                      sets: update.sets || targetEx.sets,
                      reps: update.reps || targetEx.reps,
                    }).eq('id', targetEx.id)
                    results.push('workout_modified:updated sets/reps for ' + update.old_exercise_name)
                  }
                }
                console.log('[execute-action] workout_modified: ' + update.action + ' on ' + update.day_name)
              }
            }
          } catch (e) {
            console.error('[execute-action] workout_modified error:', e.message)
          }
        } else if (update.type === 'plan_regenerated') {
          // Handle plan regeneration inside batch update
          const planType = update.planType || 'meal'
          console.log(`[execute-action] Batch plan_regenerated: ${planType} for userId:`, userId)
          
          const { data: profileForPlan } = await supabase.from('profiles').select('*').eq('id', userId).single()
          if (profileForPlan) {
            // Apply fallbacks
            profileForPlan.age = profileForPlan.age || 25
            profileForPlan.gender = profileForPlan.gender || 'male'
            profileForPlan.weight = profileForPlan.weight || 150
            profileForPlan.height = profileForPlan.height || '5ft10'
            profileForPlan.activity_level = profileForPlan.activity_level || 'moderately_active'
            profileForPlan.diet_type = profileForPlan.diet_type || 'balanced'
            profileForPlan.experience_level = profileForPlan.experience_level || 'intermediate'
            profileForPlan.training_days_per_week = profileForPlan.training_days_per_week || 4
            profileForPlan.goal = profileForPlan.goal || 'lean muscle'
            profileForPlan.full_name = profileForPlan.full_name || 'there'
            
            // Apply any preference from chat message
            const chatMsg = (req.body?.lastUserMessage || '').toLowerCase()
            if (chatMsg.includes('vegetarian') || chatMsg.includes('veg only')) profileForPlan.diet_type = 'vegetarian'
            if (chatMsg.includes('vegan')) profileForPlan.diet_type = 'vegan'
            
            // Deactivate current plan
            if (planType === 'workout' || planType === 'both') {
              await supabase.from('workout_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
            }
            if (planType === 'meal' || planType === 'both') {
              await supabase.from('meal_plans').update({ is_active: false }).eq('user_id', userId).eq('is_active', true)
            }
            
            await generateAndSavePlan(userId, profileForPlan, planType)
            results.push(`plan_regenerated:${planType}`)
          }
        } else if (update.type === 'composition_logged') {
          const logData = { user_id: userId, logged_at: new Date().toISOString() }
          if (update.weight != null) {
            logData.weight_lbs = parseFloat(update.weight)
          }
          if (update.body_fat_percentage != null) {
            logData.body_fat_pct = parseFloat(update.body_fat_percentage)
          }
          if (update.muscle_mass != null) {
            logData.muscle_mass_lbs = parseFloat(update.muscle_mass)
          }
          const { error } = await supabase.from('body_composition_logs').upsert(logData, { onConflict: 'user_id,logged_at' })
          if (error) throw new Error(error.message)
          results.push('Body composition logged')
        }
      }
      
      const fieldLabels = { weight: 'weight', goal: 'goal', age: 'age', height: 'height', gender: 'gender', training_days_per_week: 'training days', diet_type: 'diet', experience_level: 'experience', activity_level: 'activity level' }
      const updatedFields = Object.keys(profileUpdates).map(f => fieldLabels[f] || f)
      
      // Build appropriate success message
      const foodLogResults = results.filter(r => r.startsWith('food_logged:'))
      let message
      const mealModResults = results.filter(r => r.startsWith('meal_modified:'))
      
      if (foodLogResults.length > 0 && updatedFields.length === 0 && mealModResults.length === 0) {
        const foods = foodLogResults.map(r => { try { return JSON.parse(r.replace('food_logged:', '')).food_name } catch { return 'food' } })
        message = `Logged ${foods.join(', ')} to your food diary! 🍽️`
      } else if (updatedFields.length === 1) {
        message = `Done! Updated your ${updatedFields[0]}.`
      } else if (updatedFields.length > 1) {
        message = `Done! Updated your ${updatedFields.slice(0, -1).join(', ')} and ${updatedFields[updatedFields.length - 1]}.`
      } else {
        message = 'Done! Changes saved.'
      }
      
      // If any plan-affecting fields were updated in batch, recalculate plan targets
      const planFields = ['weight', 'goal', 'activity_level', 'training_days_per_week']
      const changedPlanField = Object.keys(profileUpdates).some(f => planFields.includes(f))
      if (changedPlanField) {
        try {
          const { data: freshProfile } = await supabase.from('profiles').select('*').eq('id', userId).single()
          if (freshProfile) await recalculatePlanTargets(userId, freshProfile)
        } catch (e) { console.log('[execute-action] Batch plan recalc failed:', e.message) }
      }

      // Extract any food_logged results to return to app
      const foodLogs = results.filter(r => r.startsWith('food_logged:')).map(r => {
        try { return JSON.parse(r.replace('food_logged:', '')) } catch { return null }
      }).filter(Boolean)
      
      const mealMods = mealModResults.map(r => { try { return JSON.parse(r.replace('meal_modified:', '')) } catch { return null } }).filter(Boolean)
      const workoutMods = results.filter(r => r.startsWith('workout_modified:'))
      return res.json({ 
        success: true, 
        message, 
        foodLogs: foodLogs.length > 0 ? foodLogs : undefined,
        mealModified: mealMods.length > 0 ? mealMods : undefined,
        workoutModified: workoutMods.length > 0 ? true : undefined,
      })
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

        // If weight updated, also write to body_composition_logs so all screens reflect it
        if (action.field === 'weight') {
          const todayStr = new Date().toISOString().split('T')[0]
          await supabase.from('body_composition_logs').upsert({
            user_id: userId,
            logged_at: todayStr,
            weight_lbs: parseFloat(action.value),
          }, { onConflict: 'user_id,logged_at' })
          console.log(`[execute-action] Also wrote weight_lbs=${action.value} to body_composition_logs`)
        }

        // If goal, weight, or activity changed — recalculate and update meal plan targets
        const planAffectingFields = ['weight', 'goal', 'activity_level', 'training_days_per_week']
        if (planAffectingFields.includes(action.field)) {
          try {
            const { data: freshProfile } = await supabase.from('profiles').select('*').eq('id', userId).single()
            if (freshProfile) {
              await recalculatePlanTargets(userId, freshProfile)
              console.log(`[execute-action] Recalculated plan targets after ${action.field} change`)
            }
          } catch (e) {
            console.log('[execute-action] Plan target recalc failed (non-fatal):', e.message)
          }
        }

        return res.json({
          success: true,
          message: getUpdateConfirmation(action.field, action.value),
          updated: data[0],
          planRecalculated: planAffectingFields.includes(action.field)
        })
      }

      case 'composition_logged': {
        const todayStr = new Date().toISOString().split('T')[0]
        const logData = { user_id: userId, logged_at: todayStr }
        if (action.weight != null) logData.weight_lbs = parseFloat(action.weight)
        if (action.body_fat_percentage != null) logData.body_fat_pct = parseFloat(action.body_fat_percentage)
        if (action.muscle_mass != null) logData.muscle_mass_lbs = parseFloat(action.muscle_mass)

        console.log('[execute-action] Upserting body composition:', JSON.stringify(logData))

        const { data, error } = await supabase
          .from('body_composition_logs')
          .upsert(logData, { onConflict: 'user_id,logged_at' })
          .select()

        if (error) {
          console.error('[execute-action] Supabase error:', error.message)
          return res.status(500).json({ error: error.message })
        }

        return res.json({ success: true, message: 'Updated! Your body composition has been saved.' })
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
// Fetch real usage context for smarter plan generation
async function getUserUsageContext(userId) {
  try {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const sevenDaysStr = sevenDaysAgo.toISOString().split('T')[0]

    const [nutritionLogs, bodyCompLogs, workoutSessions, currentMeals] = await Promise.all([
      // Last 7 days of nutrition logs
      supabase.from('daily_nutrition_logs')
        .select('logged_date, total_calories, total_protein_g, followed_plan')
        .eq('user_id', userId)
        .gte('logged_date', sevenDaysStr)
        .order('logged_date', { ascending: false }),

      // Last 3 body comp logs (weight trend)
      supabase.from('body_composition_logs')
        .select('logged_at, weight_lbs, body_fat_pct')
        .eq('user_id', userId)
        .order('logged_at', { ascending: false })
        .limit(3),

      // Workout sessions this week
      supabase.from('workout_sessions')
        .select('started_at, completed_at')
        .eq('user_id', userId)
        .gte('started_at', sevenDaysStr),

      // Current active meal plan meals (to avoid repeating)
      supabase.from('meal_plans')
        .select('name, daily_calorie_target, daily_protein_target, meal_plan_days(meals(name, meal_type, calories, protein_g))')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single()
    ])

    const logs = nutritionLogs.data || []
    const bodyLogs = bodyCompLogs.data || []
    const sessions = workoutSessions.data || []
    const currentPlan = currentMeals.data

    // Calculate averages
    const logsWithData = logs.filter(l => l.total_calories > 0)
    const avgCalories = logsWithData.length
      ? Math.round(logsWithData.reduce((s, l) => s + (l.total_calories || 0), 0) / logsWithData.length)
      : null
    const avgProtein = logsWithData.length
      ? Math.round(logsWithData.reduce((s, l) => s + (l.total_protein_g || 0), 0) / logsWithData.length)
      : null
    const followedPlanDays = logs.filter(l => l.followed_plan).length
    const loggedDays = logs.length

    // Weight trend
    const latestWeight = bodyLogs[0]?.weight_lbs
    const oldestWeight = bodyLogs[bodyLogs.length - 1]?.weight_lbs
    const weightTrend = latestWeight && oldestWeight && latestWeight !== oldestWeight
      ? (latestWeight - oldestWeight > 0 ? 'gaining' : 'losing')
      : 'stable'

    // Current meal names (to avoid exact repeats)
    const currentMealNames = []
    if (currentPlan?.meal_plan_days) {
      for (const day of currentPlan.meal_plan_days.slice(0, 2)) {
        for (const meal of (day.meals || [])) {
          if (meal.name && !currentMealNames.includes(meal.name)) {
            currentMealNames.push(meal.name)
          }
        }
      }
    }

    return {
      avgCalories,
      avgProtein,
      followedPlanDays,
      loggedDays,
      workoutsThisWeek: sessions.length,
      weightTrend,
      latestWeight,
      currentMealNames: currentMealNames.slice(0, 8), // top 8 to avoid repeats
      currentPlanCalTarget: currentPlan?.daily_calorie_target,
      currentPlanProteinTarget: currentPlan?.daily_protein_target,
    }
  } catch (e) {
    console.log('[getUserUsageContext] error:', e.message)
    return {}
  }
}

async function generateAndSavePlan(userId, profile, planType) {
  const {
    full_name, age, gender, weight, height,
    goal, experience_level, activity_level,
    diet_type, training_days_per_week
  } = profile

  const trainingDays = training_days_per_week || 4

  // Fetch real usage data for smarter, data-driven plan
  const usageCtx = await getUserUsageContext(userId)
  console.log('[generate-plan] Usage context:', JSON.stringify(usageCtx))

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

  // Build usage context block for the prompt
  const usageContextBlock = usageCtx.avgCalories || usageCtx.avgProtein ? `
REAL USER BEHAVIOR DATA (last 7 days — use this to make the plan realistic):
${usageCtx.avgCalories ? `- Average daily calories actually consumed: ${usageCtx.avgCalories} kcal` : ''}
${usageCtx.avgProtein ? `- Average daily protein actually consumed: ${usageCtx.avgProtein}g` : ''}
${usageCtx.loggedDays ? `- Days with nutrition data: ${usageCtx.loggedDays}/7` : ''}
${usageCtx.followedPlanDays ? `- Days they followed their meal plan: ${usageCtx.followedPlanDays}/${usageCtx.loggedDays}` : ''}
${usageCtx.workoutsThisWeek !== undefined ? `- Workouts completed this week: ${usageCtx.workoutsThisWeek}` : ''}
${usageCtx.weightTrend ? `- Weight trend: ${usageCtx.weightTrend} (latest: ${usageCtx.latestWeight ? usageCtx.latestWeight + ' lbs' : 'unknown'})` : ''}
${usageCtx.currentMealNames?.length ? `- Current plan meals (DO NOT repeat these, create variety): ${usageCtx.currentMealNames.join(', ')}` : ''}

USE THIS DATA TO:
- If avg protein < target: increase protein in every meal, use higher-protein sources
- If avg calories < target by >200: meals may be too large/complex — simplify portions
- If followed plan < 3 days: meals may be too complex — make them simpler and faster to prepare
- If weight is gaining and goal is lose_fat: reduce calories by additional 100 kcal
- If weight is losing fast (>2 lbs/week): increase calories slightly to protect muscle
- Always create variety — never repeat meals from the current plan
` : ''

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
- CRITICAL: Each day's 3 meals MUST sum to EXACTLY the dailyProteinTarget (+/- 5g) and dailyCalorieTarget (+/- 50 kcal). Verify your math before responding. If meals add up to less, increase protein amounts.
- High-protein meal sources to use: chicken/fish curry (25-35g protein per serving), dal makhani (18g/cup), paneer dishes (14g/100g), egg dishes (6g/egg), Greek yogurt (17g/cup)
- Meal instructions must be ONE specific sentence with exact portions and key macros, e.g. '150g chicken breast + 1 cup basmati rice + 2 tbsp dal (~35g protein, 450 kcal)'
${generateMeal && usageCtx.avgCalories ? usageContextBlock : ''}` : ''}`

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

    // Clear today's confirmed meal IDs since they belonged to the old plan
    const todayForClear = new Date().toISOString().split('T')[0]
    await supabase
      .from('daily_nutrition_logs')
      .update({ confirmed_meal_ids: [], total_protein_g: 0, total_calories: 0 })
      .eq('user_id', userId)
      .eq('logged_date', todayForClear)

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
        // Server-side protein enforcement: if day's meals don't sum to target, boost dinner
        const dayProteinTotal = day.meals.reduce((sum, m) => sum + (m.proteinG || 0), 0)
        const targetProtein = planData.mealPlan.dailyProteinTarget || proteinG
        const proteinGap = targetProtein - dayProteinTotal
        
        if (proteinGap > 5) {
          // Find dinner (or last meal) and boost its protein
          const dinnerIdx = day.meals.findIndex(m => m.mealType === 'dinner')
          const boostIdx = dinnerIdx >= 0 ? dinnerIdx : day.meals.length - 1
          const boost = Math.round(proteinGap)
          day.meals[boostIdx].proteinG = (day.meals[boostIdx].proteinG || 0) + boost
          // Add equivalent calories (4 kcal/g protein)
          day.meals[boostIdx].calories = (day.meals[boostIdx].calories || 0) + (boost * 4)
          console.log(`[generate-plan] Day ${day.dayNumber}: protein gap ${proteinGap}g, boosted ${day.meals[boostIdx].name} dinner by +${boost}g protein`)
        }

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
// SNAP MEAL — Quick food photo analysis with GPT-4o Vision
// =============================================
app.post('/api/snap-meal', async (req, res) => {
  const { imageBase64, userId } = req.body

  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 required' })
  }

  console.log(`[snap-meal] Analyzing food image for userId: ${userId}`)

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
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
            text: `Analyze this food image. Be quick and realistic.

Return ONLY this JSON (no markdown, no explanation):
{
  "name": "simple food name",
  "calories": 400,
  "protein": 25,
  "confidence": "high"
}

Rules:
- name: short and simple (e.g. "Dal with Rice" not "Traditional Indian Dal Makhani with Steamed Basmati Rice")
- calories: realistic estimate for the portion shown
- protein: realistic protein grams
- confidence: "high" if food is clear, "low" if unsure
- If you cannot identify food, return: {"error": "Could not identify food in this image"}`
          }
        ]
      }],
      max_tokens: 150,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const raw = completion.choices[0].message.content
    console.log(`[snap-meal] Response: ${raw}`)

    const result = JSON.parse(raw)

    if (result.error) {
      return res.status(422).json({ error: result.error })
    }

    res.json({
      success: true,
      meal: {
        name: result.name,
        calories: Math.round(result.calories),
        protein: Math.round(result.protein),
        confidence: result.confidence || 'medium'
      }
    })

  } catch (error) {
    console.error('[snap-meal] Error:', error.message)
    res.status(500).json({ error: 'Failed to analyze image. Please try again.' })
  }
})

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
