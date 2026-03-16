const myCorrectAnswers = [
  {
    "questionNumber": 1,
    "correctOptions": [
      "The Product Owner only adds items at the end of a Sprint.", 
      "The stakeholders can add items at any time.", 
      "Sprint Retrospective", 
      "Sprint Review"
    ]
  },
  {
    "questionNumber": 2,
    "correctOptions": [
      "They provide a window of focus to improve productivity.",
      "They create a sense of urgency to drive prioritization."
    ]
  },
  {
    "questionNumber": 3,
    "correctOptions": [
      "Between one and four weeks"
    ]
  }
];
// ========================================
// Array to hold our final scraped data
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

    // 3. Construct the object and add it to our main array
    scrapedAssessment.push({
        questionNumber: index + 1,
        type: questionType,
        question: questionText,
        options: options
    });
});
}

// Output the final result as a nicely formatted JSON string
console.log(JSON.stringify(scrapedAssessment, null, 2));
// [
//   {
//     "questionNumber": 1,
//     "type": "single_answer",
//     "question": "Which of the following best describes why Scrum Teams refer to the Product Backlog as a living artifact?",
//     "options": [
//       "The Product Owner only adds items at the end of a Sprint.",
//       "The stakeholders can add items at any time.",
//       "The Product Owner can add items at any time.",
//       "The team members only add items at the end of a Sprint."
//     ]
//   },
//   {
//     "questionNumber": 2,
//     "type": "single_answer",
//     "question": "A Product Owner writes a user story for an item in a Sprint. They ensure the team can discuss the item and make adjustments as needed. Which I.N.V.E.S.T. story writing criteria are they trying to fulfill?",
//     "options": [
//       "Independent",
//       "Negotiable",
//       "Valuable",
//       "Estimitable"
//     ]
//   },