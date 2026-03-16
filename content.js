chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {  
  if (request.action === "getSelection") {
    const arrayQuestions = scrapeAssessment();   
    console.log(arrayQuestions);
    
    // Send it back to the popup
    sendResponse({ data: arrayQuestions });
  }
  if(request.action === "applyAIResponse") {
    const aiAnswers = request.data;
    console.log("AI Answers received in content.js:", aiAnswers);
    applyAnswersToDOM(aiAnswers);
  }
  // Return true to indicate we will send a response asynchronously
  return true; 
});
function scrapeAssessment() {
    const scrapedAssessment = [];

    // Select all the main container blocks for the questions
    const questionBlocks = document.querySelectorAll('.css-1erl2aq');

    questionBlocks.forEach((block, index) => {
        // 1. Extract the Question Text
        const promptNode = block.querySelector('[id^="prompt-autoGradableResponseId"] [data-testid="cml-viewer"]');
        
        // Skip if it doesn't match our expected structure
        if (!promptNode) return; 
        
        const questionText = promptNode.innerText.trim();

        // 2. Extract the Options and Question Type
        const options = [];
        let questionType = 'unknown';
        
        // Find all option wrappers within this specific question block
        const optionNodes = block.querySelectorAll('.rc-Option');

        // Check if it has multiple choice/checkbox options
        if (optionNodes.length > 0) {
            optionNodes.forEach(opt => {
                const textNode = opt.querySelector('[data-testid="cml-viewer"]');
                const inputNode = opt.querySelector('input');

                if (textNode && inputNode) {
                    // Push the clean text of the option
                    options.push(textNode.innerText.trim());
                    
                    // Determine the question type based on the input attribute
                    if (questionType === 'unknown') {
                        questionType = inputNode.type === 'radio' ? 'single_answer' : 'multiple_answer';
                    }
                }
            });
        } else {
            // 3. Fallback for Text Input Questions
            // Look for a standard text input, an input with no type defined, or a textarea
            const textInputNode = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea');
            
            if (textInputNode) {
                questionType = 'text_input';
                // For text inputs, the 'options' array remains empty
            }
        }

        // 4. Construct the object and add it to our main array
        scrapedAssessment.push({
            questionNumber: index + 1,
            type: questionType,
            question: questionText,
            options: options
        });
    });

    return scrapedAssessment;
}
function applyAnswersToDOM(correctAnswers) {
    // Select all the main container blocks for the questions
    const questionBlocks = document.querySelectorAll('.css-1erl2aq');

    questionBlocks.forEach((block, index) => {
        const currentQuestionNumber = index + 1;
        
        // Find the matching answer data from our JSON for this specific question
        const answerData = correctAnswers.find(q => q.questionNumber === currentQuestionNumber);
        
        // If we don't have an answer for this question, or the array is empty, skip it
        if (!answerData || !answerData.correctOptions || answerData.correctOptions.length === 0) return; 

        // Check if there are option wrappers (multiple choice / checkbox)
        const optionNodes = block.querySelectorAll('.rc-Option');

        if (optionNodes.length > 0) {
            // --- HANDLE MULTIPLE CHOICE & CHECKBOXES ---
            optionNodes.forEach(opt => {
                const textNode = opt.querySelector('[data-testid="cml-viewer"]');
                const inputNode = opt.querySelector('input');

                if (textNode && inputNode) {
                    const optionText = textNode.innerText.trim();
                    const shouldBeSelected = answerData.correctOptions.includes(optionText);

                    if (shouldBeSelected && !inputNode.checked) {
                        // It's a correct answer but currently unchecked -> Click it
                        inputNode.click();
                    } else if (!shouldBeSelected && inputNode.checked && inputNode.type === 'checkbox') {
                        // It's an incorrect answer but currently checked -> Unclick it
                        inputNode.click();
                    }
                }
            });
        } else {
            // --- HANDLE TEXT INPUTS ---
            // Look for a standard text input, an input with no type defined, or a textarea
            const textInputNode = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea');
            
            if (textInputNode) {
                // Grab the generated text string from our JSON
                const textToType = answerData.correctOptions[0]; 
                
                // 1. Set the raw value
                textInputNode.value = textToType;
                
                // 2. Dispatch events so the React application registers the state change
                textInputNode.dispatchEvent(new Event('input', { bubbles: true }));
                textInputNode.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
    
    console.log("Answers applied successfully!");
}