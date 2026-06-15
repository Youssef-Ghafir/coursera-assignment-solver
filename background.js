chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.includes("coursera.org/learn/")) return;

  const storage = await chrome.storage.local.get(["autopilotActive", "autopilotQueue", "autopilotIndex"]);
  if (!storage.autopilotActive) return;

  const queue = storage.autopilotQueue || [];
  const index = storage.autopilotIndex || 0;
  const nextIndex = index + 1;

  if (nextIndex < queue.length) {
    setTimeout(async () => {
      await chrome.storage.local.set({ autopilotIndex: nextIndex });
      chrome.tabs.update(tabId, { url: queue[nextIndex] });
    }, 3000);
  } else {
    await chrome.storage.local.set({ autopilotActive: false });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchAIExplanation") {
    getAIResponse(request.text, request.withExplanations || false, request.humanStyle || false, request.customInstructions || "")
      .then((explanation) => sendResponse({ result: explanation }))
      .catch((error) => sendResponse({ error: error.message || "Failed to fetch from AI." }));
    return true;
  }

  if (request.action === "notifyCompletion") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "Coursera Auto Solver",
      message: `Completed ${request.count} items!${request.locked ? ` (${request.locked} locked skipped)` : ''} Refresh the page.`
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === "generateADHDNotes") {
    generateADHDNotes(request.courseId, request.contents)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "generateFlashcardsAI") {
    generateFlashcards(request.courseId, request.contents)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "generatePeerReview") {
    generatePeerReview(request.rubric, request.submission)
      .then((result) => sendResponse({ result }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "transcriptQA") {
    transcriptQA(request.question, request.transcript)
      .then((answer) => sendResponse({ answer }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "generateForumPost") {
    generateForumPost(request.topic, request.courseId)
      .then((post) => sendResponse({ post }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "generateCode") {
    generateCode(request.instructions, request.language)
      .then((code) => sendResponse({ code }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "tutorChat") {
    tutorChat(request.message, request.context, request.history)
      .then((reply) => sendResponse({ reply }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === "quizPilotItemDone") {
    (async () => {
      const s = await chrome.storage.local.get(['quizPilotActive', 'quizPilotQueue', 'quizPilotIndex']);
      if (!s.quizPilotActive) { sendResponse({ ok: true }); return; }

      const queue = s.quizPilotQueue || [];
      const nextIndex = (s.quizPilotIndex || 0) + 1;

      if (nextIndex < queue.length) {
        await chrome.storage.local.set({ quizPilotIndex: nextIndex });
        if (sender && sender.tab && sender.tab.id) {
          setTimeout(() => {
            chrome.tabs.update(sender.tab.id, { url: queue[nextIndex] });
          }, 3000);
        }
      } else {
        await chrome.storage.local.set({ quizPilotActive: false });
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "All Quizzes Done!",
          message: `Completed all ${queue.length} graded assignments. Check your grades on Coursera.`
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === "walkAwayCourseDone") {
    (async () => {
      const s = await chrome.storage.local.get(['walkAwayActive', 'walkAwayCourses', 'walkAwayIndex']);
      if (!s.walkAwayActive) { sendResponse({ ok: true }); return; }

      const courses = s.walkAwayCourses || [];
      const nextIndex = (s.walkAwayIndex || 0) + 1;

      if (nextIndex < courses.length) {
        await chrome.storage.local.set({ walkAwayIndex: nextIndex });
        const nextCourse = courses[nextIndex];
        if (sender && sender.tab && sender.tab.id) {
          setTimeout(() => {
            chrome.tabs.update(sender.tab.id, { url: `https://www.coursera.org/learn/${nextCourse.id}` });
          }, 4000);
        }
      } else {
        await chrome.storage.local.set({ walkAwayActive: false });
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "Walk-Away Mode Complete!",
          message: `All ${courses.length} courses completed! 🎓 Check your Coursera dashboard.`
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

const PROVIDER_DEFAULTS = {
    gemini:     { model: 'gemini-2.5-pro',                            label: 'Gemini' },
    openai:     { model: 'gpt-4o-mini',                               label: 'OpenAI' },
    groq:       { model: 'llama-3.3-70b-versatile',                   label: 'Groq' },
    claude:     { model: 'claude-haiku-4-5-20251001',                 label: 'Claude' },
    openrouter: { model: 'meta-llama/llama-3.3-70b-instruct:free',    label: 'OpenRouter' }
};

async function callAI(prompt, temperature = 0.3) {
    const s = await chrome.storage.local.get(['aiProvider', 'geminiKey', 'userApiKey', 'openaiKey', 'groqKey', 'claudeKey', 'openrouterKey']);
    const provider = s.aiProvider || 'gemini';
    const keyMap = {
        gemini:     s.geminiKey || s.userApiKey,
        openai:     s.openaiKey,
        groq:       s.groqKey,
        claude:     s.claudeKey,
        openrouter: s.openrouterKey
    };
    const key = keyMap[provider];
    if (!key) throw new Error(`No API key saved. Add your ${PROVIDER_DEFAULTS[provider]?.label || provider} key in the popup Settings.`);

    const modelStore = await chrome.storage.local.get(['aiModel_' + provider]);
    const model = modelStore['aiModel_' + provider] || PROVIDER_DEFAULTS[provider].model;

    let text;

    if (provider === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature } })
        });
        const data = await res.json();
        if (!res.ok) {
            if (res.status === 429) throw new Error('Rate limit hit. Wait a moment and try again.');
            throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        if (!data.candidates?.[0]) throw new Error('Invalid response from Gemini API');
        text = data.candidates[0].content.parts[0].text;

    } else if (['openai', 'groq', 'openrouter'].includes(provider)) {
        const baseUrl = provider === 'openai' ? 'https://api.openai.com/v1'
            : provider === 'groq' ? 'https://api.groq.com/openai/v1'
            : 'https://openrouter.ai/api/v1';
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
        if (provider === 'openrouter') headers['X-Title'] = 'Coursera Auto Solver';
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature })
        });
        const data = await res.json();
        if (!res.ok) {
            if (res.status === 429) throw new Error('Rate limit hit. Wait a moment and try again.');
            throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error(`Invalid response from ${PROVIDER_DEFAULTS[provider].label} API`);

    } else if (provider === 'claude') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({ model, max_tokens: 8096, messages: [{ role: 'user', content: prompt }], temperature })
        });
        const data = await res.json();
        if (!res.ok) {
            if (res.status === 429) throw new Error('Rate limit hit. Wait a moment and try again.');
            throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        text = data.content?.[0]?.text;
        if (!text) throw new Error('Invalid response from Claude API');
    }

    return text.replace(/```json/gi, '').replace(/```html/gi, '').replace(/```/g, '').trim();
}

async function getAIResponse(questionsArray, withExplanations = false, humanStyle = false, customInstructions = "", attempt = 1) {
  const questionsJsonString = JSON.stringify(questionsArray, null, 2);

  const explanationRule = withExplanations
    ? `7. Add an "explanation" key to each object with a 1-sentence reason WHY that answer is correct.`
    : '';

  const explanationExample = withExplanations
    ? `,\n    "explanation": "This is correct because..."`
    : '';

  const humanStyleRule = humanStyle ? `
IMPORTANT WRITING STYLE FOR ESSAY AND TEXT QUESTIONS:
Write like a regular college student who genuinely understands the material. Specifically:
- Write in first person ("I think", "In my opinion", "I'd recommend", "One thing I noticed")
- Use contractions naturally (it's, they're, I'm, we'd, doesn't, can't)
- Vary your sentence length — mix short punchy sentences with longer ones
- Use casual transitions: "So", "That said", "Another thing is", "On top of that", "Also", "To be fair"
- Sound like someone who knows the topic but is writing a class assignment, not a corporate whitepaper
- DO NOT use these words: crucial, paramount, delve, leverage, streamline, pivotal, it's worth noting, in conclusion, it is important to note, furthermore, moreover, utilize
- Write in flowing paragraphs — no bullet points in essays
- Occasionally hedge: "I think", "probably", "seems like", "in my view"
- If a word count is mentioned, stay close to that range
- Make it sound natural and a little conversational, not robotic or perfectly polished
` : '';

  const customRule = customInstructions ? `\nADDITIONAL USER INSTRUCTIONS: ${customInstructions}` : '';

  const prompt = `
You are an expert subject matter assistant. I am providing you with a JSON array of quiz questions.
Your task is to determine the correct answer(s) for each question based on the provided options or generate a short answer if it requires text input.
${humanStyleRule}${customRule}

INPUT FORMAT:
${questionsJsonString}

OUTPUT RULES (STRICTLY ENFORCED):
1. You must respond ONLY with a valid JSON array. Do not include any introductory text, explanations, or markdown code blocks (do not use \`\`\`json).
2. The output must be an array of objects.
3. Each object must have exactly two keys: "questionNumber" (integer) and "correctOptions" (array of strings).
4. For "single_answer" and "multiple_answer" types: The strings inside "correctOptions" MUST be exact, copy-pasted matches of the correct strings from the input "options" array.
5. For "text_input" types: Generate a concise, highly accurate, and direct answer to the question. Place this generated text as a single string inside the "correctOptions" array.
6. For "essay" types: Generate a well-thought-out, comprehensive essay response (e.g. 3-4 sentences, or fulfilling the constraints of the prompt) as requested. Place this as a single string inside the "correctOptions" array.
${explanationRule}

OUTPUT FORMAT EXAMPLE:
[
  {
    "questionNumber": 1,
    "correctOptions": ["Exact text of the correct option here"]${explanationExample}
  },
  {
    "questionNumber": 2,
    "correctOptions": ["This is a generated concise answer for a text input question"]${explanationExample}
  }
]

Now, evaluate the input and provide the raw JSON output.
`;

  const rawText = await callAI(prompt, 0.1);
  try {
    return JSON.parse(rawText);
  } catch {
    if (attempt < 2) return new Promise(r => setTimeout(r, 2000)).then(() => getAIResponse(questionsArray, withExplanations, humanStyle, customInstructions, attempt + 1));
    throw new Error(`AI returned unparseable output: ${rawText.slice(0, 120)}`);
  }
}

async function generateADHDNotes(courseId, contents) {
  const MAX_CONTENT_CHARS = 28000;
  let totalChars = 0;
  const cappedContents = contents.filter(c => {
    if (totalChars + c.text.length > MAX_CONTENT_CHARS) return false;
    totalChars += c.text.length;
    return true;
  });

  const contentText = cappedContents.length > 0
    ? cappedContents.map(c => `## ${c.name}\n${c.text}`).join('\n\n')
    : `Course: ${courseId} (no reading content available — generate general study framework)`;

  const prompt = `You are creating study notes optimized for people with ADHD from a Coursera course.

COURSE CONTENT:
${contentText}

OUTPUT: Generate comprehensive HTML study notes. Use this exact structure:
- <h1> for the overall title
- <h2> for each major topic
- Bullet points: keep each point to 1-2 lines MAX
- Wrap the single most important insight per section in: <div class="key-point">🔑 Key Point: ...</div>
- Wrap motivation/context in: <div class="why-matters">💡 Why this matters: ...</div>
- Bold key terms with <strong>
- Start each <h2> section with a one-sentence TL;DR in <p class="tldr">
- Use simple direct language, no jargon without a brief definition
- Max 5 bullets per group before starting a new subsection

OUTPUT ONLY the HTML body content (no <html>, <head>, or <body> tags). Start directly with <h1>.`;

  const cleanHtml = await callAI(prompt, 0.3);
  await chrome.storage.local.set({ generatedNotes: cleanHtml });
  await chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
}

async function generateFlashcards(courseId, contents) {
  const contentText = (contents || []).length > 0
    ? contents.map(c => `${c.name ? `## ${c.name}\n` : ''}${c.text || c}`).join('\n\n')
    : `Course: ${courseId} — generate general study flashcards based on the course topic.`;

  const prompt = `You are creating flashcards for a Coursera course.

COURSE CONTENT:
${contentText.slice(0, 25000)}

Generate 15-25 flashcards as a JSON array. Each flashcard has a "front" (question or term) and "back" (answer or definition). Keep each card concise and clear.
Respond ONLY with a valid JSON array, no markdown, no explanation.

Example: [{"front": "What is X?", "back": "X is Y because Z."}, ...]`;

  const raw = await callAI(prompt, 0.3);
  let cardsArray;
  try {
    cardsArray = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse flashcards from AI response.");
  }

  await chrome.storage.local.set({ generatedFlashcards: cardsArray });
  chrome.tabs.create({ url: chrome.runtime.getURL('flashcards.html') });
}

async function generatePeerReview(rubric, submission) {
  const prompt = `You are filling out a Coursera peer review.

Rubric:
${rubric}

Student's submission:
${(submission || "").slice(0, 4000)}

For each rubric criterion, write a thoughtful, fair, 2-3 sentence review. Sound like a fellow student giving genuine feedback.
Respond as a JSON array: [{"criterion": "...", "review": "...", "score": "full_credit|partial_credit|no_credit"}]
Respond ONLY with valid JSON, no markdown.`;

  const raw = await callAI(prompt, 0.4);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse peer review response.");
  }
}

async function transcriptQA(question, transcript) {
  const prompt = `You are a helpful tutor answering questions about a video lecture.

${transcript ? `Video transcript:\n${transcript.slice(0, 6000)}\n\n` : ''}Question: ${question}

Answer clearly and concisely in 2-4 sentences. If the transcript doesn't contain the answer, say so and answer from general knowledge.`;

  return await callAI(prompt, 0.4);
}

async function generateForumPost(topic, courseId) {
  const prompt = `Write a thoughtful discussion forum post for a Coursera course.

Topic/prompt: ${topic}

Write 2-3 paragraphs in a natural, student voice. Be genuine and on-topic. No bullet points. Sound like a real student sharing their perspective and personal take on the subject. Use contractions and conversational language.`;

  return await callAI(prompt, 0.7);
}

async function generateCode(instructions, language) {
  const lang = language || "detect from context";
  const prompt = `You are solving a programming assignment for a Coursera course.

Instructions:
${instructions}

Language: ${lang}

Write complete, correct, working code that satisfies the requirements. Include brief inline comments explaining key steps. Output ONLY the code — no explanation text, no markdown code fences.`;

  return await callAI(prompt, 0.2);
}

async function tutorChat(message, context, history) {
  const historyText = (history || [])
    .map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.text}`)
    .join('\n');

  const prompt = `You are a helpful, friendly AI tutor for a Coursera course. Answer questions clearly and concisely — like explaining to a smart friend, not writing a textbook.

${context ? `Current page content:\n${context.slice(0, 4000)}\n\n` : ''}${historyText ? `Conversation so far:\n${historyText}\n\n` : ''}Student: ${message}

Tutor:`;

  return await callAI(prompt, 0.5);
}
