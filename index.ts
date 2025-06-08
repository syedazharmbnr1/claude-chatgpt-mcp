#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { runAppleScript } from "run-applescript";
import { run } from "@jxa/run";

// Define the ChatGPT tool
const CHATGPT_TOOL: Tool = {
	name: "chatgpt",
	description: "Interact with the ChatGPT desktop app on macOS. Features: 1) 'ask' - Send prompts with customizable wait time (1-30s, default 12s) and get only the last ChatGPT response, 2) 'get_conversations' - List available conversations, 3) 'get_last_message' - Get the complete last ChatGPT response from current conversation. Wait time guidelines: Quick responses (greetings, simple questions): 5-8s, Medium responses (explanations, simple code): 10-15s, Complex responses (detailed analysis, long code): 15-20s, Very complex responses (comprehensive analysis): 20-30s.",
	inputSchema: {
		type: "object",
		properties: {
			operation: {
				type: "string",
				description: "Operation to perform: 'ask' (send prompt and get last response), 'get_conversations' (list chats), or 'get_last_message' (get complete last ChatGPT response)",
				enum: ["ask", "get_conversations", "get_last_message"],
			},
			prompt: {
				type: "string",
				description:
					"The prompt to send to ChatGPT (required for ask operation)",
			},
			conversation_id: {
				type: "string",
				description:
					"Optional conversation ID to continue a specific conversation",
			},
			wait_time: {
				type: "number",
				description:
					"Time in seconds to wait for ChatGPT response (default: 12, max: 30). Choose based on expected response complexity: 5-8s for quick responses (greetings, simple questions), 10-15s for medium responses (explanations, simple code), 15-20s for complex responses (detailed analysis, long code), 20-30s for very complex responses (comprehensive analysis, extensive code).",
				minimum: 1,
				maximum: 30,
			},
		},
		required: ["operation"],
	},
};

const server = new Server(
	{
		name: "ChatGPT MCP Tool",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

// Check if ChatGPT app is installed and running
async function checkChatGPTAccess(): Promise<boolean> {
	try {
		const isRunning = await runAppleScript(`
      tell application "System Events"
        return application process "ChatGPT" exists
      end tell
    `);

		if (isRunning !== "true") {
			console.log("ChatGPT app is not running, attempting to launch...");
			try {
				await runAppleScript(`
          tell application "ChatGPT" to activate
          delay 2
        `);
			} catch (activateError) {
				console.error("Error activating ChatGPT app:", activateError);
				throw new Error(
					"Could not activate ChatGPT app. Please start it manually.",
				);
			}
		}

		return true;
	} catch (error) {
		console.error("ChatGPT access check failed:", error);
		throw new Error(
			`Cannot access ChatGPT app. Please make sure ChatGPT is installed and properly configured. Error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// Function to send a prompt to ChatGPT (Y 좌표 기반 정렬 방식)
async function askChatGPT(
	prompt: string,
	conversationId?: string,
	waitTime: number = 12,
): Promise<string> {
	await checkChatGPTAccess();
	try {
		// Validate and set wait time
		const safeWaitTime = Math.min(Math.max(waitTime, 1), 30);
		
		// Function to check if text contains Korean characters
		const hasKorean = (text: string): boolean => {
			return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
		};

		// Function to properly encode text for AppleScript, including handling of Chinese characters
		const encodeForAppleScript = (text: string): string => {
			// Only escape double quotes, leave other characters as is
			return text.replace(/"/g, '\\"');
		};

		const encodedPrompt = encodeForAppleScript(prompt);
		const useClipboard = hasKorean(prompt);
		
		const script = `
      tell application "ChatGPT"
        activate
        delay 2
      end tell
      
      tell application "System Events"
        tell process "ChatGPT"
          -- Check if ChatGPT window exists
          if not (exists window 1) then
            return "ChatGPT window not found"
          end if
          
          ${
						conversationId
							? `
            try
              click button "${conversationId}" of group 1 of group 1 of window 1
              delay 1
            end try
          `
							: ""
					}
          
          -- ChatGPT accepts direct keyboard input, no need to click specific elements
          -- Clear any existing text using key codes
          key code 0 using {command down}  -- cmd+a
          delay 0.5
          key code 51  -- delete key
          delay 1.5
          
          ${useClipboard ? `
          -- Use clipboard + key codes for Korean text
          set the clipboard to "${encodedPrompt}"
          delay 0.5
          key code 9 using {command down}  -- cmd+v
          delay 2
          ` : `
          -- For English text, type directly
          keystroke "${encodedPrompt}"
          delay 2
          `}
          
          -- Send the message using key code
          key code 36  -- return key
          delay 1
          
          -- Wait for ChatGPT to respond (user-specified wait time)
          delay ${safeWaitTime}
          
          -- Y 좌표 기반 텍스트 수집 및 정렬
          set allElements to entire contents of window 1
          set textWithPositions to {}
          
          -- 모든 텍스트 요소를 Y 좌표와 함께 수집
          repeat with elem in allElements
            try
              if (role of elem) is "AXStaticText" then
                set elemText to (description of elem)
                if elemText is not missing value and elemText is not "" and length of elemText > 3 then
                  -- 기본 UI 요소 필터링
                  if elemText is not "text entry area" and elemText does not contain "New chat" then
                    try
                      set elemPosition to position of elem
                      set yPos to item 2 of elemPosition
                      set end of textWithPositions to {elemText, yPos}
                    on error
                      -- 위치 정보 없으면 기본값으로 추가
                      set end of textWithPositions to {elemText, 0}
                    end try
                  end if
                end if
              end if
            end try
          end repeat
          
          -- Y 좌표 기준으로 정렬 (큰 값이 아래쪽/최신)
          set listSize to count of textWithPositions
          repeat with i from 1 to listSize - 1
            repeat with j from 1 to listSize - i
              set item1 to item j of textWithPositions
              set item2 to item (j + 1) of textWithPositions
              set yPos1 to item 2 of item1
              set yPos2 to item 2 of item2
              
              if yPos1 > yPos2 then
                -- 위치 교환 (작은 Y값이 앞으로)
                set item j of textWithPositions to item2
                set item (j + 1) of textWithPositions to item1
              end if
            end repeat
          end repeat
          
          -- 우리 질문 찾기 (Y 좌표로 정렬된 상태에서)
          set ourQuestionIndex to 0
          set questionText to "${encodedPrompt}"
          
          repeat with i from 1 to (count of textWithPositions)
            set textInfo to item i of textWithPositions
            set elemText to item 1 of textInfo
            
            if elemText contains questionText then
              set ourQuestionIndex to i
              exit repeat
            end if
          end repeat
          
          -- 우리 질문 이후의 모든 텍스트 수집 (최신 답변)
          if ourQuestionIndex > 0 then
            set responseTexts to {}
            repeat with i from (ourQuestionIndex + 1) to (count of textWithPositions)
              set textInfo to item i of textWithPositions
              set elemText to item 1 of textInfo
              set end of responseTexts to elemText
            end repeat
            
            -- 답변 텍스트들 조합
            if (count of responseTexts) > 0 then
              set fullResponse to ""
              repeat with responseText in responseTexts
                set fullResponse to fullResponse & responseText & "\n\n"
              end repeat
              return fullResponse
            else
              return "No response found after question"
            end if
          else
            -- 질문을 찾지 못한 경우, 가장 최신 텍스트들 반환
            if (count of textWithPositions) > 5 then
              set latestTexts to items -5 thru -1 of textWithPositions
              set latestResponse to ""
              repeat with textInfo in latestTexts
                set elemText to item 1 of textInfo
                set latestResponse to latestResponse & elemText & "\n\n"
              end repeat
              return latestResponse
            else
              return "No response received from ChatGPT"
            end if
          end if
        end tell
      end tell
    `;
		const result = await runAppleScript(script);
		
		// Post-process the result to clean up any UI text that might have been captured
		let cleanedResult = result
			.replace(/Regenerate( response)?/g, '')
			.replace(/Continue generating/g, '')
			.replace(/▍/g, '')
			.trim();
			
		// More context-aware incomplete response detection
		const isLikelyComplete = 
			cleanedResult.length > 50 || // Longer responses are likely complete
			cleanedResult.endsWith('.') || 
			cleanedResult.endsWith('!') || 
			cleanedResult.endsWith('?') ||
			cleanedResult.endsWith(':') ||
			cleanedResult.endsWith(')') ||
			cleanedResult.endsWith('}') ||
			cleanedResult.endsWith(']') ||
			cleanedResult.includes('\n\n') || // Multiple paragraphs suggest completeness
			/^[A-Z].*[.!?]$/.test(cleanedResult); // Complete sentence structure
			
		if (cleanedResult.length > 0 && !isLikelyComplete) {
			console.warn(`Warning: ChatGPT response may be incomplete (waited ${safeWaitTime}s)`);
		}
		
		return cleanedResult;
	} catch (error) {
		console.error("Error interacting with ChatGPT:", error);
		throw new Error(
			`Failed to get response from ChatGPT: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

// Function to get the last ChatGPT message (모든 블럭 반환)
async function getLastMessage(): Promise<string> {
	await checkChatGPTAccess();
	try {
		const script = `
      tell application "ChatGPT"
        activate
        delay 1
      end tell
      
      tell application "System Events"
        tell process "ChatGPT"
          if not (exists window 1) then
            return "ChatGPT window not found"
          end if
          
          -- Y 좌표 기반 텍스트 수집 및 정렬
          set allElements to entire contents of window 1
          set textWithPositions to {}
          
          repeat with elem in allElements
            try
              if (role of elem) is "AXStaticText" then
                set elemText to (description of elem)
                if elemText is not missing value and elemText is not "" and length of elemText > 3 then
                  if elemText is not "text entry area" and elemText does not contain "New chat" then
                    try
                      set elemPosition to position of elem
                      set yPos to item 2 of elemPosition
                      set end of textWithPositions to {elemText, yPos}
                    on error
                      set end of textWithPositions to {elemText, 0}
                    end try
                  end if
                end if
              end if
            end try
          end repeat
          
          -- Y 좌표 기준으로 정렬
          set listSize to count of textWithPositions
          repeat with i from 1 to listSize - 1
            repeat with j from 1 to listSize - i
              set item1 to item j of textWithPositions
              set item2 to item (j + 1) of textWithPositions
              set yPos1 to item 2 of item1
              set yPos2 to item 2 of item2
              
              if yPos1 > yPos2 then
                set item j of textWithPositions to item2
                set item (j + 1) of textWithPositions to item1
              end if
            end repeat
          end repeat

          -- 마지막 메시지 블럭들 반환
          if (count of textWithPositions) > 0 then
            -- 마지막 메시지의 시작 인덱스 찾기: 위에서 아래로 내려가며, 마지막 "우리 질문" 이후부터가 마지막 메시지
            set lastMsgStartIdx to 1
            set lastMsgEndIdx to (count of textWithPositions)
            -- 대화가 번갈아가며 쌓인다고 가정하고, 마지막 연속된 블럭 묶음 찾기
            -- 아래에서 위로 올라가며, 빈 줄이거나 시스템 안내문이 아닌 첫 블럭부터 위로 같은 화자(답변) 블럭을 모두 포함
            set lastSpeakerText to item 1 of item -1 of textWithPositions
            set lastSpeakerIdx to (count of textWithPositions)
            repeat with i from (count of textWithPositions) - 1 to 1 by -1
              set curText to item 1 of item i of textWithPositions
              -- 만약 현재 블럭이 마지막 블럭과 동일한 화자(즉, 답변의 일부)라면 포함
              -- (여기서는 단순히 연속된 블럭을 묶음으로 처리)
              -- 만약 중간에 "model context protocol 말한거야" 등 사용자의 질문이 나오면 멈춤
              if curText is "model context protocol 말한거야" then
                set lastMsgStartIdx to i + 1
                exit repeat
              end if
            end repeat
            -- 마지막 메시지 블럭들 합치기 (elemText만 추출)
            set elemTextsOnly to {}
            repeat with i from 1 to (count of textWithPositions)
              set elemText to item 1 of item i of textWithPositions
              set end of elemTextsOnly to elemText
            end repeat
            set lastMsgBlocks to {}
            repeat with i from lastMsgStartIdx to lastMsgEndIdx
              set blockText to item i of elemTextsOnly
              set end of lastMsgBlocks to blockText
            end repeat
            set fullResponse to ""
            repeat with blockText in lastMsgBlocks
              set fullResponse to fullResponse & blockText & "\n"
            end repeat
            -- 연속된 빈 줄 제거 및 안전한 문자열 변환
            set responseLines to every paragraph of fullResponse
            set cleanedLines to {}
            repeat with l in responseLines
              if l is not "" then
                set end of cleanedLines to l
              end if
            end repeat
            set cleanedResponse to ""
            repeat with l in cleanedLines
              set cleanedResponse to cleanedResponse & l & "\n"
            end repeat
            return cleanedResponse
          else
            return "No messages found"
          end if
        end tell
      end tell
    `;
		
		const result = await runAppleScript(script);
		let cleanedResult = result
			.replace(/Regenerate( response)?/g, '')
			.replace(/Continue generating/g, '')
			.replace(/▍/g, '')
			.trim();
			
		return cleanedResult || "No last message found";
	} catch (error) {
		console.error("Error getting last message from ChatGPT:", error);
		throw new Error(
			`Failed to get last message from ChatGPT: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

// Function to get available conversations
async function getConversations(): Promise<string[]> {
	try {
		// Run AppleScript to get conversations from ChatGPT app
		const result = await runAppleScript(`
      -- Check if ChatGPT is running
      tell application "System Events"
        if not (application process "ChatGPT" exists) then
          return "ChatGPT is not running"
        end if
      end tell

      tell application "ChatGPT"
        -- Activate ChatGPT and give it time to respond
        activate
        delay 1.5

        tell application "System Events"
          tell process "ChatGPT"
            -- Check if ChatGPT window exists
            if not (exists window 1) then
              return "No ChatGPT window found"
            end if
            
            -- Try to get conversation titles with multiple approaches
            set conversationsList to {}
            
            try
              -- First attempt: try buttons in group 1 of group 1
              if exists group 1 of group 1 of window 1 then
                set chatButtons to buttons of group 1 of group 1 of window 1
                repeat with chatButton in chatButtons
                  set buttonName to name of chatButton
                  if buttonName is not "New chat" then
                    set end of conversationsList to buttonName
                  end if
                end repeat
              end if
              
              -- If we didn't find any conversations, try an alternative approach
              if (count of conversationsList) is 0 then
                -- Try to find UI elements by accessibility description
                set uiElements to UI elements of window 1
                repeat with elem in uiElements
                  try
                    if exists (attribute "AXDescription" of elem) then
                      set elemDesc to value of attribute "AXDescription" of elem
                      if elemDesc is not "New chat" and elemDesc is not "" then
                        set end of conversationsList to elemDesc
                      end if
                    end if
                  end try
                end repeat
              end if
              
              -- If still no conversations found, return a specific message
              if (count of conversationsList) is 0 then
                return "No conversations found"
              end if
            on error errMsg
              -- Return error message for debugging
              return "Error: " & errMsg
            end try
            
            return conversationsList
          end tell
        end tell
      end tell
    `);

		// Parse the AppleScript result into an array
		if (result === "ChatGPT is not running") {
			console.error("ChatGPT application is not running");
			throw new Error("ChatGPT application is not running");
		} else if (result === "No ChatGPT window found") {
			console.error("No ChatGPT window found");
			throw new Error("No ChatGPT window found");
		} else if (result === "No conversations found") {
			console.error("No conversations found in ChatGPT");
			return []; // Return empty array instead of error message
		} else if (result.startsWith("Error:")) {
			console.error(result);
			throw new Error(result);
		}
		
		const conversations = result.split(", ");
		return conversations;
	} catch (error) {
		console.error("Error getting ChatGPT conversations:", error);
		throw new Error("Error retrieving conversations: " + (error instanceof Error ? error.message : String(error)));
	}
}

function isChatGPTArgs(args: unknown): args is {
	operation: "ask" | "get_conversations" | "get_last_message";
	prompt?: string;
	conversation_id?: string;
	wait_time?: number;
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, prompt, conversation_id, wait_time } = args as any;

	if (!operation || !["ask", "get_conversations", "get_last_message"].includes(operation)) {
		return false;
	}

	// Validate required fields based on operation
	if (operation === "ask" && !prompt) return false;

	// Validate field types if present
	if (prompt && typeof prompt !== "string") return false;
	if (conversation_id && typeof conversation_id !== "string") return false;
	if (wait_time && typeof wait_time !== "number") return false;

	return true;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [CHATGPT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const { name, arguments: args } = request.params;

		if (!args) {
			throw new Error("No arguments provided");
		}

		if (name === "chatgpt") {
			if (!isChatGPTArgs(args)) {
				throw new Error("Invalid arguments for ChatGPT tool");
			}

			switch (args.operation) {
				case "ask": {
					if (!args.prompt) {
						throw new Error("Prompt is required for ask operation");
					}

					const response = await askChatGPT(
						args.prompt, 
						args.conversation_id,
						args.wait_time || 12
					);

					return {
						content: [
							{
								type: "text",
								text: response || "No response received from ChatGPT.",
							},
						],
						isError: false,
					};
				}

				case "get_conversations": {
					const conversations = await getConversations();

					return {
						content: [
							{
								type: "text",
								text:
									conversations.length > 0
										? `Found ${conversations.length} conversation(s):\n\n${conversations.join("\n")}`
										: "No conversations found in ChatGPT.",
							},
						],
						isError: false,
					};
				}

				case "get_last_message": {
					const lastMessage = await getLastMessage();

					return {
						content: [
							{
								type: "text",
								text: lastMessage || "No last message found.",
							},
						],
						isError: false,
					};
				}

				default:
					throw new Error(`Unknown operation: ${args.operation}`);
			}
		}

		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: `Error: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();

await server.connect(transport);
console.error("ChatGPT MCP Server running on stdio");
