let capturedUserId = null;
let capturedCourseId = null;
let capturedAuthToken = null;
let capturedRequestHeaders = {};
let capturedCourseMaterials = null;
let latestCodeQuestionBindings = new Map();
let monacoRequestSequence = 0;

const capturedHeaderNames = new Set([
    "x-csrf2-cookie",
    "x-csrf2-token",
    "x-csrf3-token",
    "x-csrftoken",
    "x-requested-with"
]);

function normalizeInterceptedHeaders(headers) {
    if (Array.isArray(headers)) {
        return headers.filter((header) => Array.isArray(header) && header.length >= 2);
    }
    if (headers && typeof headers === "object") {
        return Object.entries(headers);
    }
    return [];
}

function captureRequestHeaders(headers) {
    normalizeInterceptedHeaders(headers).forEach(([name, value]) => {
        const normalizedName = String(name).toLowerCase();
        if (!capturedHeaderNames.has(normalizedName) || value == null) return;

        capturedRequestHeaders[normalizedName] = String(value);
        if (normalizedName === "x-csrf3-token") {
            capturedAuthToken = String(value);
        }
    });
}

// Listen for messages from the natively injected intercept script
window.addEventListener("message", (event) => {

    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.source !== "auto-coursera-interceptor") {
        return;
    }

    const { url, contentType, response, request } = event.data;

    // Capture the course materials directly from the intercepted response!
    if (request && request.url && request.url.includes("onDemandCourseMaterials.v2")) {
        if (response && response.linked && response.linked['onDemandCourseMaterialItems.v2']) {
            capturedCourseMaterials = response;
            console.log("Captured Course Materials natively via Interceptor!");
        }
    }

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

    if (request?.headers) {
        captureRequestHeaders(request.headers);
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
    if (request.action === "fillDialogueAnswer") {
        fillCurrentDialogueAnswer()
            .then(() => sendResponse({ status: "filled" }))
            .catch((error) => sendResponse({ error: error.message || "Could not fill the dialogue answer." }));
        return true;
    }

    if (request.action === "solveQuizDirectly") {
        sendResponse({ status: "started" });
        solveCurrentAssessment();
        return true;
    }
    if (request.action === "getSelection") {
        scrapeAssessmentDetailed()
            .then(({ questions, issues }) => sendResponse({ data: questions, issues }))
            .catch((error) => sendResponse({ error: error.message || "Could not extract this assessment." }));
        return true;
    }
    if (request.action === "applyAIResponse") {
        applyAnswersToDOM(request.data)
            .then((summary) => sendResponse({ data: summary }))
            .catch((error) => sendResponse({ error: error.message || "Could not apply the AI answers." }));
        return true;
    }
    if (request.action === "getCourseRequirements" || request.action === "getGradedAssignments") {
        getCourseRequirements()
            .then((result) => sendResponse({ data: result }))
            .catch((error) => sendResponse({ error: error.message || "Could not load course requirements." }));
        return true;
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

function getCurrentCourseSlug() {
    const match = window.location.pathname.match(/\/learn\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

async function loadCourseMaterials() {
    if (capturedCourseMaterials?.linked?.['onDemandCourseMaterialItems.v2']) {
        return capturedCourseMaterials;
    }

    const courseSlug = getCurrentCourseSlug();
    if (!courseSlug) {
        throw new Error("Open a Coursera course page first.");
    }

    const apiUrl = new URL("https://www.coursera.org/api/onDemandCourseMaterials.v2/");
    apiUrl.searchParams.set("q", "slug");
    apiUrl.searchParams.set("slug", courseSlug);
    apiUrl.searchParams.set(
        "includes",
        "modules,lessons,passableItemGroups,passableItemGroupChoices,passableLessonElements,items"
    );
    apiUrl.searchParams.set(
        "fields",
        [
            "moduleIds",
            "onDemandCourseMaterialModules.v1(name,slug,lessonIds,optional)",
            "onDemandCourseMaterialLessons.v1(name,slug,itemIds,elementIds,optional)",
            "onDemandCourseMaterialPassableItemGroups.v1(requiredPassedCount,passableItemGroupChoiceIds,trackId)",
            "onDemandCourseMaterialPassableItemGroupChoices.v1(name,description,itemIds)",
            "onDemandCourseMaterialPassableLessonElements.v1(gradingWeight,isRequiredForPassing)",
            "onDemandCourseMaterialItems.v2(name,slug,timeCommitment,contentSummary,isLocked,lockedStatus,itemLockedReasonCode,itemLockSummary)"
        ].join(",")
    );
    apiUrl.searchParams.set("showLockedItems", "true");

    const response = await fetch(apiUrl.href, { credentials: "include" });
    if (response.status === 401 || response.status === 403) {
        throw new Error("Coursera could not authorize the course request. Sign in, then try again.");
    }
    if (!response.ok) {
        throw new Error(`Coursera course materials request failed with HTTP ${response.status}.`);
    }

    const materials = await response.json();
    if (!materials?.linked?.['onDemandCourseMaterialItems.v2']) {
        throw new Error("Coursera returned course materials in an unsupported format.");
    }

    capturedCourseMaterials = materials;
    capturedCourseId = courseSlug;
    return materials;
}

function linkedCourseCollection(materials, key) {
    const collection = materials?.linked?.[key];
    return Array.isArray(collection) ? collection : [];
}

function requirementRoute(type) {
    return {
        exam: "exam",
        quiz: "quiz",
        staffGraded: "assignment-submission",
        ungradedAssignment: "assignment-submission",
        peer: "peer",
        phasedPeer: "peer",
        programming: "programming",
        gradedProgramming: "programming"
    }[type] || "";
}

function courseItemType(item) {
    return item?.contentSummary?.typeName || item?.itemClass || "unknown";
}

function courseItemIsLocked(item) {
    if (item?.isLocked === true) return true;
    const status = String(item?.lockedStatus || "").trim().toLowerCase();
    if (!status || ["unlocked", "not_locked", "available"].includes(status)) return false;
    return status === "locked" || status.startsWith("locked_") || status.startsWith("hard_locked");
}

function itemIdFromPassable(passableId) {
    const parts = String(passableId || "").split("~").filter(Boolean);
    return parts.at(-1) || "";
}

function normalizeCourseRequirements(materials, courseSlug) {
    const items = linkedCourseCollection(materials, 'onDemandCourseMaterialItems.v2');
    const modules = linkedCourseCollection(materials, 'onDemandCourseMaterialModules.v1');
    const lessons = linkedCourseCollection(materials, 'onDemandCourseMaterialLessons.v1');
    const passables = linkedCourseCollection(materials, 'onDemandCourseMaterialPassableLessonElements.v1');
    const passableGroups = linkedCourseCollection(materials, 'onDemandCourseMaterialPassableItemGroups.v1');
    const passableChoices = linkedCourseCollection(materials, 'onDemandCourseMaterialPassableItemGroupChoices.v1');

    const itemById = new Map(items.map((item) => [item.id, item]));
    const moduleById = new Map(modules.map((module) => [module.id, module]));
    const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const choiceById = new Map(passableChoices.map((choice) => [choice.id, choice]));

    const rootModuleIds = Array.isArray(materials?.elements?.[0]?.moduleIds)
        ? materials.elements[0].moduleIds
        : modules.map((module) => module.id);
    const moduleOrder = new Map(rootModuleIds.map((id, index) => [id, index]));
    const lessonOrder = new Map();
    modules.forEach((module) => {
        (module.lessonIds || []).forEach((lessonId, index) => {
            lessonOrder.set(lessonId, index);
        });
    });
    const itemOrder = new Map();
    lessons.forEach((lesson) => {
        const lessonItems = lesson.itemIds || lesson.elementIds || [];
        lessonItems.forEach((itemId, index) => itemOrder.set(itemIdFromPassable(itemId), index));
    });

    const passableByItemId = new Map();
    passables.forEach((passable) => {
        const itemId = itemIdFromPassable(passable.id);
        if (itemId) passableByItemId.set(itemId, passable);
    });

    const groupByItemId = new Map();
    passableGroups.forEach((group) => {
        const choiceIds = Array.isArray(group.passableItemGroupChoiceIds)
            ? group.passableItemGroupChoiceIds
            : [];
        choiceIds.forEach((choiceId) => {
            const choice = choiceById.get(choiceId);
            (choice?.itemIds || []).forEach((rawItemId) => {
                const itemId = itemIdFromPassable(rawItemId);
                if (!itemId) return;
                groupByItemId.set(itemId, {
                    name: choice.name || "Assignment choice",
                    requiredPassedCount: Number(group.requiredPassedCount) || 0,
                    choiceCount: choiceIds.length
                });
            });
        });
    });

    const hasConfirmedMetadata = passableByItemId.size > 0 || groupByItemId.size > 0;
    const fallbackTypes = new Set(["exam", "quiz", "staffGraded", "gradedProgramming", "peer", "phasedPeer"]);
    const candidateIds = hasConfirmedMetadata
        ? new Set([...passableByItemId.keys(), ...groupByItemId.keys()])
        : new Set(items.filter((item) => fallbackTypes.has(courseItemType(item))).map((item) => item.id));

    const requirements = [];
    candidateIds.forEach((itemId) => {
        const item = itemById.get(itemId);
        if (!item) return;

        const passable = passableByItemId.get(itemId);
        const group = groupByItemId.get(itemId) || null;
        const module = moduleById.get(item.moduleId);
        const lesson = lessonById.get(item.lessonId);
        const type = courseItemType(item);
        const route = requirementRoute(type);
        const gradingWeight = Number(passable?.gradingWeight);
        const hasGradingWeight = Number.isFinite(gradingWeight) && gradingWeight > 0;
        const safeItemSlug = item.slug ? encodeURIComponent(item.slug) : "";
        const link = route && safeItemSlug
            ? `https://www.coursera.org/learn/${encodeURIComponent(courseSlug)}/${route}/${encodeURIComponent(item.id)}/${safeItemSlug}`
            : null;

        requirements.push({
            id: item.id,
            name: item.name || "Graded activity",
            type,
            moduleName: module?.name || "Other course work",
            lessonName: lesson?.name || "",
            gradingWeight: hasGradingWeight ? gradingWeight : null,
            weightPercent: null,
            requiredForPassing: passable?.isRequiredForPassing === true,
            groupRequirement: group,
            locked: courseItemIsLocked(item),
            lockReason: item.itemLockSummary || item.itemLockedReasonCode || "",
            timeCommitment: Number.isFinite(Number(item.timeCommitment)) ? Number(item.timeCommitment) : null,
            source: passable || group ? "confirmed" : "detected",
            link,
            moduleOrder: moduleOrder.get(item.moduleId) ?? Number.MAX_SAFE_INTEGER,
            lessonOrder: lessonOrder.get(item.lessonId) ?? Number.MAX_SAFE_INTEGER,
            itemOrder: itemOrder.get(item.id) ?? Number.MAX_SAFE_INTEGER
        });
    });

    requirements.sort((first, second) => (
        first.moduleOrder - second.moduleOrder ||
        first.lessonOrder - second.lessonOrder ||
        first.itemOrder - second.itemOrder ||
        first.name.localeCompare(second.name)
    ));

    const totalGradingWeight = requirements.reduce(
        (total, requirement) => total + (requirement.gradingWeight || 0),
        0
    );
    const unresolvedCount = Math.max(0, candidateIds.size - requirements.length);
    if (totalGradingWeight > 0 && unresolvedCount === 0) {
        requirements.forEach((requirement) => {
            if (requirement.gradingWeight) {
                requirement.weightPercent = Math.round(
                    (requirement.gradingWeight / totalGradingWeight) * 1000
                ) / 10;
            }
        });
    }

    requirements.forEach((requirement) => {
        delete requirement.moduleOrder;
        delete requirement.lessonOrder;
        delete requirement.itemOrder;
    });

    return {
        requirements,
        summary: {
            confirmed: hasConfirmedMetadata,
            totalGradingWeight,
            requiredCount: requirements.filter((requirement) => requirement.requiredForPassing).length,
            lockedCount: requirements.filter((requirement) => requirement.locked).length,
            unmappedCount: requirements.filter((requirement) => !requirement.link).length,
            unresolvedCount
        }
    };
}

async function getCourseRequirements() {
    const courseSlug = getCurrentCourseSlug();
    if (!courseSlug) throw new Error("Open a Coursera course page first.");
    const materials = await loadCourseMaterials();
    return normalizeCourseRequirements(materials, courseSlug);
}

function assessmentQuestionBlocks() {
    const semanticBlocks = Array.from(document.querySelectorAll('[data-testid^="part-Submission_"]'))
        .filter((block) => block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]'));
    if (semanticBlocks.length > 0) return semanticBlocks;
    return Array.from(document.querySelectorAll('.css-1erl2aq, .css-12u8wr5'));
}

function codeEditorDescriptor(block) {
    const editorHosts = Array.from(block.querySelectorAll('.monaco-editor[data-uri]'));
    const evaluator = block.querySelector('.cml-code-evaluator');
    let editorHost = null;

    if (editorHosts.length === 1) {
        editorHost = editorHosts[0];
    } else if (evaluator && editorHosts.length > 1) {
        const precedingEditors = editorHosts.filter((host) => (
            host.compareDocumentPosition(evaluator) & Node.DOCUMENT_POSITION_FOLLOWING
        ));
        editorHost = precedingEditors.at(-1) || null;
    }

    if (!editorHost) throw new Error("Could not identify the editable Coursera code model.");
    const modelUri = editorHost.getAttribute("data-uri") || "";
    const language = editorHost.closest('[data-mode-id]')?.getAttribute("data-mode-id") || "unknown";
    if (!modelUri.startsWith("inmemory://model/")) {
        throw new Error("Coursera returned an unsupported code model URI.");
    }
    return { modelUri, language };
}

function requestMonacoBridge(action, payload = {}) {
    return new Promise((resolve, reject) => {
        const requestId = `monaco-${Date.now()}-${++monacoRequestSequence}`;
        const timeoutId = setTimeout(() => {
            window.removeEventListener("message", handleResponse);
            reject(new Error("Coursera's code editor did not respond."));
        }, 2600);

        function handleResponse(event) {
            if (
                event.source !== window ||
                event.data?.source !== "auto-coursera-monaco-response" ||
                event.data?.requestId !== requestId
            ) return;

            clearTimeout(timeoutId);
            window.removeEventListener("message", handleResponse);
            if (event.data.ok) resolve(event.data);
            else reject(new Error(event.data.error || "Coursera's code editor request failed."));
        }

        window.addEventListener("message", handleResponse);
        window.postMessage({
            source: "auto-coursera-monaco-request",
            requestId,
            action,
            ...payload
        }, "*");
    });
}

async function scrapeAssessmentDetailed() {
    const questions = [];
    const issues = [];
    const nextCodeBindings = new Map();
    const questionBlocks = assessmentQuestionBlocks();

    for (let index = 0; index < questionBlocks.length; index += 1) {
        const block = questionBlocks[index];
        const questionNumber = index + 1;
        const promptNode = block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]');
        if (!promptNode) continue;

        const question = {
            questionNumber,
            type: "unknown",
            question: promptNode.innerText.trim(),
            options: []
        };

        if (block.dataset.testid === "part-Submission_CodeExpressionQuestion") {
            try {
                const descriptor = codeEditorDescriptor(block);
                const modelResponse = await requestMonacoBridge("read-model", {
                    modelUri: descriptor.modelUri
                });
                const currentCode = String(modelResponse.value ?? "");

                question.type = "code_expression";
                question.language = descriptor.language;
                question.currentCode = currentCode;
                nextCodeBindings.set(questionNumber, {
                    modelUri: descriptor.modelUri,
                    expectedValue: currentCode
                });
                questions.push(question);
            } catch (error) {
                issues.push({ questionNumber, error: error.message || "Could not read the code editor." });
            }
            continue;
        }

        const optionNodes = Array.from(block.querySelectorAll('.rc-Option'));
        if (optionNodes.length > 0) {
            optionNodes.forEach((option) => {
                const textNode = option.querySelector('[data-testid="cml-viewer"]');
                const inputNode = option.querySelector('input[type="radio"], input[type="checkbox"]');
                if (!textNode || !inputNode) return;
                question.options.push(textNode.innerText.trim());
                if (question.type === "unknown") {
                    question.type = inputNode.type === "radio" ? "single_answer" : "multiple_answer";
                }
            });
        } else {
            const slateEditor = block.querySelector('[data-slate-editor="true"]');
            const standardInput = block.querySelector(
                'input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea:not(.inputarea)'
            );
            if (slateEditor) question.type = "essay";
            else if (standardInput) question.type = "text_input";
        }

        questions.push(question);
    }

    latestCodeQuestionBindings = nextCodeBindings;
    return { questions, issues };
}

function requestAIAssessmentAnswers(questions) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { action: "fetchAIExplanation", text: questions },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response?.error) {
                    reject(new Error(response.error));
                    return;
                }
                if (!Array.isArray(response?.result)) {
                    reject(new Error("The AI provider returned an unsupported answer."));
                    return;
                }
                resolve(response.result);
            }
        );
    });
}

function cleanCodeAnswer(value) {
    const code = String(value ?? "");
    const fenced = code.match(/^\s*```(?:[a-z0-9_+-]+)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
    return fenced ? fenced[1] : code;
}

async function applyAnswersToDOM(correctAnswers) {
    const questionBlocks = assessmentQuestionBlocks();
    const failures = [];
    let appliedCount = 0;

    for (let index = 0; index < questionBlocks.length; index += 1) {
        const block = questionBlocks[index];
        const questionNumber = index + 1;
        const answerData = Array.isArray(correctAnswers)
            ? correctAnswers.find((answer) => answer.questionNumber === questionNumber)
            : null;
        if (!answerData?.correctOptions?.length) continue;

        if (block.dataset.testid === "part-Submission_CodeExpressionQuestion") {
            const binding = latestCodeQuestionBindings.get(questionNumber);
            if (!binding) {
                failures.push({ questionNumber, error: "Code editor binding unavailable." });
                continue;
            }
            try {
                const replacement = cleanCodeAnswer(answerData.correctOptions[0]);
                if (!replacement.trim()) throw new Error("The AI returned empty code.");
                await requestMonacoBridge("replace-model", {
                    modelUri: binding.modelUri,
                    expectedValue: binding.expectedValue,
                    value: replacement
                });
                appliedCount += 1;
            } catch (error) {
                failures.push({ questionNumber, error: error.message || "Could not update the code editor." });
            }
            continue;
        }

        const optionNodes = Array.from(block.querySelectorAll('.rc-Option'));
        if (optionNodes.length > 0) {
            const availableAnswers = new Set();
            optionNodes.forEach((option) => {
                const textNode = option.querySelector('[data-testid="cml-viewer"]');
                const inputNode = option.querySelector('input[type="radio"], input[type="checkbox"]');
                if (!textNode || !inputNode) return;
                const optionText = textNode.innerText.trim();
                availableAnswers.add(optionText);
                const shouldBeSelected = answerData.correctOptions.includes(optionText);
                if (shouldBeSelected && !inputNode.checked) inputNode.click();
                else if (!shouldBeSelected && inputNode.checked && inputNode.type === "checkbox") inputNode.click();
            });

            if (answerData.correctOptions.every((answer) => availableAnswers.has(answer))) {
                appliedCount += 1;
            } else {
                failures.push({ questionNumber, error: "The selected option no longer matches the page." });
            }
            continue;
        }

        const textInputNode = block.querySelector(
            'input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea:not(.inputarea), [data-slate-editor="true"]'
        );
        if (!textInputNode) {
            failures.push({ questionNumber, error: "No supported answer field was found." });
            continue;
        }

        const textToType = answerData.correctOptions[0];
        if (textInputNode.hasAttribute('contenteditable')) {
            textInputNode.focus();
            await new Promise((resolve) => setTimeout(resolve, 50));
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, textToType);
        } else {
            textInputNode.value = textToType;
            textInputNode.dispatchEvent(new Event('input', { bubbles: true }));
            textInputNode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        appliedCount += 1;
    }

    return { appliedCount, failures };
}

async function solveCurrentAssessment({ notify = true, onProgress = () => {} } = {}) {
    if (notify) showOrUpdateBanner("Extracting questions and contacting AI... 🤖", "info");
    const initialPath = window.location.pathname;
    const initialBlocks = assessmentQuestionBlocks();
    try {
        onProgress("Reading the assessment questions…");
        const { questions, issues } = await scrapeAssessmentDetailed();
        if (questions.length === 0) {
            throw new Error("No supported questions were found on this page.");
        }

        onProgress("Asking your selected AI provider…");
        const answers = await requestAIAssessmentAnswers(questions);
        const currentBlocks = assessmentQuestionBlocks();
        if (
            window.location.pathname !== initialPath ||
            initialBlocks.length !== currentBlocks.length ||
            initialBlocks.some((block, index) => block !== currentBlocks[index])
        ) {
            throw new Error("The assessment changed while answers were being generated. Try again on the current activity.");
        }
        onProgress("Filling the answers for your review…");
        const summary = await applyAnswersToDOM(answers);
        const failures = [...issues, ...summary.failures];

        if (!notify) return { ...summary, failures };
        if (failures.length === 0) {
            showOrUpdateBanner("Answers and code added successfully! ✅", "success");
            setTimeout(hideBanner, 4000);
            return;
        }

        const failedNumbers = [...new Set(failures.map((failure) => failure.questionNumber))]
            .sort((first, second) => first - second)
            .join(", ");
        showOrUpdateBanner(
            `Applied ${summary.appliedCount} answer${summary.appliedCount === 1 ? "" : "s"}. Check question${failedNumbers.includes(",") ? "s" : ""} ${failedNumbers}.`,
            "info"
        );
        setTimeout(hideBanner, 6500);
    } catch (error) {
        if (!notify) throw error;
        showOrUpdateBanner(`Error: ${error.message || "Could not solve this assessment."}`, "error");
        setTimeout(hideBanner, 5500);
    }
}

function findDialogueComposer(root) {
    const composer = root.querySelector(
        '[data-testid="coach-rich-input-field-content"] textarea:not([aria-hidden="true"]):not([readonly]):not([disabled])'
    ) || root.querySelector(
        'textarea[aria-label="Send a message"]:not([aria-hidden="true"]):not([readonly]):not([disabled])'
    );
    return composer && !composer.closest('[aria-disabled="true"]') ? composer : null;
}

function extractDialogueState() {
    const root = document.querySelector('[data-testid="coursera-coach-item"], #coursera-coach-item');
    if (!root) {
        throw new Error("No Coursera dialogue was found on this page.");
    }

    const composer = findDialogueComposer(root);
    if (!composer) {
        throw new Error("Start the Coursera dialogue and wait for its question first.");
    }

    const coachMessageNodes = Array.from(root.querySelectorAll(
        '[data-testid="chat-message-llm"] [data-testid="coach-message-markdown"]'
    ));
    const currentQuestion = coachMessageNodes
        .map((node) => node.innerText.trim())
        .filter(Boolean)
        .at(-1);

    if (!currentQuestion) {
        throw new Error("No active Coursera dialogue question was found.");
    }

    const seenMessages = new Set();
    const messages = Array.from(root.querySelectorAll('[role="list"] > [role="listitem"]'))
        .map((item) => {
            const coachContent = item.querySelector(
                '[data-testid="chat-message-llm"] [data-testid="coach-message-markdown"]'
            );
            const role = coachContent ? "coach" : "learner";
            const text = coachContent ? coachContent.innerText.trim() : dialogueMessageText(item);
            return { role, text };
        })
        .filter((message) => {
            if (!message.text) return false;
            const fingerprint = `${message.role}:${message.text}`;
            if (seenMessages.has(fingerprint)) return false;
            seenMessages.add(fingerprint);
            return true;
        });

    return { composer, currentQuestion, messages };
}

function dialogueMessageText(item) {
    const copy = item.cloneNode(true);
    copy.querySelectorAll('button, [role="toolbar"], [role="status"], [aria-live]')
        .forEach((node) => node.remove());
    return copy.innerText.trim();
}

function requestDialogueAnswer(messages, currentQuestion) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { action: "fetchDialogueAnswer", messages, currentQuestion },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response?.error) {
                    reject(new Error(response.error));
                    return;
                }
                if (!response?.result) {
                    reject(new Error("The AI provider did not return a dialogue answer."));
                    return;
                }
                resolve(response.result);
            }
        );
    });
}

function fillReactTextarea(textarea, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
    )?.set;

    if (valueSetter) {
        valueSetter.call(textarea, value);
    } else {
        textarea.value = value;
    }

    textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
    }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(value.length, value.length);
}

async function fillCurrentDialogueAnswer() {
    const initialState = extractDialogueState();
    const initialPath = window.location.pathname;
    if (initialState.composer.value.trim()) {
        throw new Error("The dialogue message box already contains text. Clear it before generating an answer.");
    }

    const reply = await requestDialogueAnswer(initialState.messages, initialState.currentQuestion);
    const currentState = extractDialogueState();

    if (
        window.location.pathname !== initialPath ||
        currentState.composer !== initialState.composer ||
        currentState.currentQuestion !== initialState.currentQuestion
    ) {
        throw new Error("The Coursera dialogue changed while the answer was being generated. Try again.");
    }
    if (currentState.composer.value.trim()) {
        throw new Error("The dialogue message box changed while the answer was being generated.");
    }

    fillReactTextarea(currentState.composer, reply);
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

        // STEP B: Complete items in parallel chunks to dramatically speed up the process while avoiding rate limits!
        const CHUNK_SIZE = 6;
        console.log(`Found ${itemsToComplete.length} items to complete! Starting loop in chunks of ${CHUNK_SIZE}...`);

        for (let i = 0; i < itemsToComplete.length; i += CHUNK_SIZE) {
            const chunk = itemsToComplete.slice(i, i + CHUNK_SIZE);
            const chunkEnd = Math.min(i + CHUNK_SIZE, itemsToComplete.length);

            showOrUpdateBanner(`Completing items ${i + 1} to ${chunkEnd} of ${itemsToComplete.length}... ⚡`);

            const chunkPromises = chunk.map(async (itemObj, indexInChunk) => {
                const itemId = itemObj.id;
                const itemType = itemObj.type;
                const absIndex = i + indexInChunk + 1;

                console.log(`[${absIndex}/${itemsToComplete.length}] Faking completion for item: ${itemId} (Type: ${itemType})`);

                try {
                    const finalUserId = capturedUserId || "~";

                    if (itemType === 'lecture' || itemType === 'unknown') {
                        return fetch(`https://www.coursera.org/api/opencourse.v1/user/${finalUserId}/course/${capturedCourseId}/item/${itemId}/lecture/videoEvents/ended?autoEnroll=false`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-CSRF3-Token": capturedAuthToken },
                            body: JSON.stringify({ "contentRequestBody": {} })
                        });
                    } else if (itemType === 'supplement') {
                        if (internalCourseId) {
                            return fetch(`https://www.coursera.org/api/onDemandSupplementCompletions.v1`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "X-CSRF3-Token": capturedAuthToken },
                                body: JSON.stringify({ "userId": parseInt(finalUserId) || finalUserId, "courseId": internalCourseId, "itemId": itemId })
                            });
                        }
                    } else {
                        console.log(`[Skipping] Item ${itemId} has type '${itemType}' and does not need automation.`);
                    }
                } catch (e) {
                    console.log(`[Error] Request failed for item ${itemId}`, e);
                }
            });

            // Wait for all fetches in the current chunk to complete simultaneously
            await Promise.all(chunkPromises);

            // Tiny intentional delay between major chunks to preserve session health
            await new Promise(r => setTimeout(r, 400));
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
