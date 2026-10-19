// Chat provider instances from a routed provider id + model id.
// (Moved out of routes/chat.ts so the Step 4 background runners can use the
// same construction without importing from the routes layer.)
import { makeAnthropicProvider } from "./anthropic.js";
import { makeOpenAIProvider } from "./openai.js";
export function makeChatProvider(providerId, modelId) {
    return providerId === "anthropic"
        ? makeAnthropicProvider(modelId)
        : makeOpenAIProvider(modelId);
}
//# sourceMappingURL=instances.js.map