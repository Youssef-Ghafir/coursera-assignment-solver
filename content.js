let capturedUserId = null;
let capturedCourseId = null;
let capturedAuthToken = null;

// Listen for messages from the natively injected intercept script
window.addEventListener("message", (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.source !== "auto-coursera-interceptor") {
        return;
    }

    const { url, contentType, response, request } = event.data;

    if (response && response.context && response.context.dispatcher) {
        try {
            capturedUserId = response.context.dispatcher.stores.ApplicationStore.userData.id;
        } catch (e) { }
    }

    if (!capturedUserId && request && request.url) {
        const userMatch = request.url.match(/user\/([0-9]+)/) || request.url.match(/userId=([0-9]+)/);
        if (userMatch) {
            capturedUserId = userMatch[1];
            console.log("Got User ID from intercepted URL:", capturedUserId);
        }
    }

    if (request && request.headers && request.headers.length > 0) {
        request.headers.forEach(header => {
            if (header[0].toLowerCase() === 'x-csrf3-token') {
                capturedAuthToken = header[1];
            }
        });
    }

    if (request && request.url && (request.url.includes("api/onDemandCourses.v1") || request.url.includes("slug="))) {
        const urlParams = new URL(request.url).searchParams;
        if (urlParams.has("slug")) {
            capturedCourseId = urlParams.get("slug");
            console.log("Got Course ID from API:", capturedCourseId);
        }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getSelection") {
        const arrayQuestions = scrapeAssessment();
        console.log(arrayQuestions);

        // Send it back to the popup
        sendResponse({ data: arrayQuestions });
    }
    if (request.action === "applyAIResponse") {
        const aiAnswers = request.data;
        console.log("AI Answers received in content.js:", aiAnswers);
        applyAnswersToDOM(aiAnswers);
    }
    if (request.action === "completeVideos") {
        if (!capturedCourseId) {
            const matchUrl = window.location.pathname.match(/\/learn\/([^/]+)/);
            if (matchUrl) {
                capturedCourseId = matchUrl[1];
                console.log("Got Course ID directly from URL Bar:", capturedCourseId);
            }
        }

        if (!capturedAuthToken) {
            sendResponse({ error: "Missing Auth Token! Please click around the course (e.g., refresh or open a new video) to grab background security tokens." });
            return true;
        }
        if (!capturedCourseId) {
            sendResponse({ error: "Missing Course ID! Please go to the main course page to grab your Course ID." });
            return true;
        }

        sendResponse({ status: "started" });
        startCompletionLoop();
    }
    // Return true to indicate we will send a response asynchronously
    return true;
});
function scrapeAssessment() {
    const scrapedAssessment = [];

    // Select all the main container blocks for the questions
    let questionBlocks = document.querySelectorAll('.css-1erl2aq');
    if (questionBlocks.length == 0) {
        questionBlocks = document.querySelectorAll('.css-12u8wr5');
    }
    console.log(questionBlocks);

    questionBlocks.forEach((block, index) => {
        // 1. Extract the Question Text
        // Practice quizzes use id^="prompt-autoGradableResponseId", Graded quizzes use id^="prompt-"
        const promptNode = block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]');

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
    let questionBlocks = document.querySelectorAll('.css-1erl2aq');
    if (questionBlocks.length === 0) {
        questionBlocks = document.querySelectorAll('.css-12u8wr5');
    }

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

// Helper UI Functions for the Banner
function showOrUpdateBanner(text, type = "info") {
    let banner = document.getElementById("auto-coursera-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "auto-coursera-banner";
        banner.style.position = "fixed";
        banner.style.bottom = "30px";
        banner.style.left = "50%";
        banner.style.transform = "translateX(-50%)";
        banner.style.zIndex = "9999999";
        banner.style.padding = "16px 32px";
        banner.style.color = "white";
        banner.style.fontWeight = "bold";
        banner.style.borderRadius = "50px";
        banner.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
        banner.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, sans-serif";
        banner.style.fontSize = "16px";
        banner.style.transition = "opacity 0.3s ease";
        document.body.appendChild(banner);
    }

    if (type === "success") {
        banner.style.backgroundColor = "#16a34a";
        banner.innerHTML = "✅ " + text;
    } else if (type === "error") {
        banner.style.backgroundColor = "#ef4444";
        banner.innerHTML = "❌ " + text;
    } else {
        banner.style.backgroundColor = "#2563eb";
        banner.innerHTML = `<span style="display:inline-block; margin-right:8px; animation: spin 1s linear infinite;">⏳</span> ` + text;

        // Inject a quick keyframe style if it doesn't exist for the spinner
        if (!document.getElementById("auto-coursera-styles")) {
            const style = document.createElement("style");
            style.id = "auto-coursera-styles";
            style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
            document.head.appendChild(style);
        }
    }
}

function hideBanner() {
    const banner = document.getElementById("auto-coursera-banner");
    if (banner) {
        banner.style.opacity = "0";
        setTimeout(() => banner.remove(), 300);
    }
}

async function startCompletionLoop() {
    console.log("Starting Auto-Completion for course: ", capturedCourseId);
    showOrUpdateBanner("Gathering course data...", "info");

    try {
        // STEP A: Fetch the course modules using the full includes string (now including contentSummary for exact types)
        const courseDataurl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds,optional),onDemandCourseMaterialLessons.v1(elementIds,optional,itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`;
        const courseDataResponse = await fetch(courseDataurl, {
            headers: {
                "X-CSRF3-Token": capturedAuthToken
            }
        });

        const courseData = await courseDataResponse.json();
        // Extract the true internal course ID (e.g., 't_wxQwp9...') from the first element
        let internalCourseId = capturedCourseId;
        if (courseData && courseData.elements && courseData.elements.length > 0 && courseData.elements[0].id) {
            internalCourseId = courseData.elements[0].id;
            console.log("Found Internal Course ID: " + internalCourseId);
        }

        const itemsToComplete = extractVideoAndReadingIds(courseData);

        if (itemsToComplete.length === 0) {
            showOrUpdateBanner("Could not find any videos/modules to complete.", "error");
            alert("Could not find any videos/modules to complete. Did you load the correct page?");
            setTimeout(hideBanner, 4000);
            return;
        }

        console.log(`Found ${itemsToComplete.length} items to complete! Starting loop...`);

        // STEP B: Complete them one by one based on explicitly known types
        for (let i = 0; i < itemsToComplete.length; i++) {
            const itemObj = itemsToComplete[i];
            const itemId = itemObj.id;
            const itemType = itemObj.type;

            console.log(`[${i + 1}/${itemsToComplete.length}] Faking completion for item: ${itemId} (Type: ${itemType})`);

            // Update UI dynamically!
            showOrUpdateBanner(`Completing item ${i + 1} of ${itemsToComplete.length}...`);

            try {
                // Coursera API fallback: sometimes it accepts '~' as the current logged-in user!
                const finalUserId = capturedUserId || "~";

                if (itemType === 'lecture' || itemType === 'unknown') {
                    // 1) Complete it natively as a Video
                    await fetch(`https://www.coursera.org/api/opencourse.v1/user/${finalUserId}/course/${capturedCourseId}/item/${itemId}/lecture/videoEvents/ended?autoEnroll=false`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-CSRF3-Token": capturedAuthToken
                        },
                        body: JSON.stringify({ "contentRequestBody": {} })
                    });
                } else if (itemType === 'supplement') {
                    // 2) Complete it natively as a Reading/Supplement without any fallback
                    if (internalCourseId) {
                        await fetch(`https://www.coursera.org/api/onDemandSupplementCompletions.v1`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-CSRF3-Token": capturedAuthToken
                            },
                            body: JSON.stringify({
                                "userId": parseInt(finalUserId) || finalUserId,
                                "courseId": internalCourseId,
                                "itemId": itemId
                            })
                        });
                    }
                } else {
                    console.log(`[Skipping] Item ${itemId} has type '${itemType}' and does not need automation.`);
                }

            } catch (e) {
                console.log(`[Error] Request failed for item ${itemId}`, e);
            }

            // Introduce a tiny humanized delay so Coursera doesn't block the flood of requests
            await new Promise(r => setTimeout(r, 300));
        }

        showOrUpdateBanner("Course Automagically Completed! Please refresh the page.", "success");
        alert("Course Automagically Completed! please refresh the page to see the changes.");
        setTimeout(hideBanner, 6000);
    } catch (err) {
        console.error(err);
        showOrUpdateBanner("An error occurred. Check browser console.", "error");
        alert("An error occurred. Check browser console.");
        setTimeout(hideBanner, 5000);
    }
}

// Helper: extracts the specific video/module ID's from Coursera's API response
function extractVideoAndReadingIds(jsonMap) {
    let ids = [];

    // When using 'includes=items', Coursera provides all items flatly in the 'linked' dictionary!
    if (jsonMap && jsonMap.linked && jsonMap.linked['onDemandCourseMaterialItems.v2']) {
        const items = jsonMap.linked['onDemandCourseMaterialItems.v2'];
        items.forEach(item => {
            // Extract the exact type using the newly added contentSummary, or fallback to itemClass
            const exactType = (item.contentSummary && item.contentSummary.typeName) ? item.contentSummary.typeName : (item.itemClass || 'unknown');

            // Determine if this item is an assignment/quiz/widget that we should NOT automate
            // Types directly from your provided JSON!
            const isQuizClass = ['quiz', 'exam', 'programming', 'phasedPeer', 'peer', 'ungradedAssignment', 'staffGraded', 'ungradedWidget'].includes(exactType);

            // Fallback to name checking just in case
            const isQuizName = item.name && (item.name.toLowerCase().includes('quiz') || item.name.toLowerCase().includes('challenge'));

            if (item && item.id && !isQuizClass && !isQuizName) {
                // Push BOTH the ID and the exact Type so the completion loop knows what to do!
                ids.push({ id: item.id, type: exactType });
            } else if (item && item.id) {
                console.log(`[Filtered out assignment/quiz]: ${item.name} (${exactType})`);
            }
        });
        return ids;
    }

    // Fallback for older V1 formats just in case
    if (jsonMap && jsonMap.elements && jsonMap.elements[0] && jsonMap.elements[0].modules) {
        jsonMap.elements[0].modules.forEach(module => {
            if (module.lessons) {
                module.lessons.forEach(lesson => {
                    if (lesson.itemIds) {
                        lesson.itemIds.forEach(itemId => ids.push({ id: itemId, type: 'unknown' }));
                    }
                });
            }
        });
    }

    return ids;
}