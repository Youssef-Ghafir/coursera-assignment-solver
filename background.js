chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchAIExplanation") {
    // // Call our async function to get the AI response
    getAIResponse(request.text)
      .then((explanation) => sendResponse({ result: explanation }))
      .catch((error) => sendResponse({ error: "Failed to fetch from AI." }));
    // Return true to tell Chrome we will send the response asynchronously
    return true;
  }
});
async function getAIResponse(questionsArray) {
  const storageData = await chrome.storage.local.get(["userApiKey"]);
  const API_KEY = storageData.userApiKey;

  if (!API_KEY) {
    console.error("Error: Please save your API key in the extension first!");
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

  // Stringify the incoming questions array so the AI can read it
  const questionsJsonString = JSON.stringify(questionsArray, null, 2);

  // The strict prompt engineered for JSON output, now with text_input rules
  const prompt = `
You are an expert subject matter assistant. I am providing you with a JSON array of quiz questions. 
Your task is to determine the correct answer(s) for each question based on the provided options or generate a short answer if it requires text input.

INPUT FORMAT:
${questionsJsonString}

OUTPUT RULES (STRICTLY ENFORCED):
1. You must respond ONLY with a valid JSON array. Do not include any introductory text, explanations, or markdown code blocks (do not use \`\`\`json).
2. The output must be an array of objects.
3. Each object must have exactly two keys: "questionNumber" (integer) and "correctOptions" (array of strings).
4. For "single_answer" and "multiple_answer" types: The strings inside "correctOptions" MUST be exact, copy-pasted matches of the correct strings from the input "options" array.
5. For "text_input" types: Generate a concise, highly accurate, and direct answer to the question. Place this generated text as a single string inside the "correctOptions" array.

OUTPUT FORMAT EXAMPLE:
[
  {
    "questionNumber": 1,
    "correctOptions": ["Exact text of the correct option here"]
  },
  {
    "questionNumber": 2,
    "correctOptions": ["This is a generated concise answer for a text input question"]
  }
]

Now, evaluate the input and provide the raw JSON output.
`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Setting a low temperature makes the AI more deterministic and less "creative" with formatting
        generationConfig: {
          temperature: 0.1,
        },
      }),
    });

    const data = await response.json();

    if (!data.candidates || !data.candidates[0]) {
      throw new Error("Invalid response from Gemini API");
    }

    const rawText = data.candidates[0].content.parts[0].text;

    // Safety check: Strip out markdown code block syntax if the AI included it anyway
    const cleanedText = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    // Parse the string into a real JavaScript Array and return it
    return JSON.parse(cleanedText);
  } catch (error) {
    console.error("API or Parsing Error:", error);
    throw error; // Rethrow to be caught in the caller
  }
}
