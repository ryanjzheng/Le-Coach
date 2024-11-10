import fp from 'fastify-plugin';
import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type VectorStore } from '@langchain/core/vectorstores';
import { type AIChatMessage, type AIChatCompletionDelta, type AIChatCompletion } from '@microsoft/ai-chat-protocol';
import { MessageBuilder } from '../lib/message-builder.js';
import { type AppConfig } from './config.js';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { AzureChatOpenAI, AzureOpenAIEmbeddings } from '@langchain/openai';
import { AzureAISearchVectorStore } from '@langchain/community/vectorstores/azure_aisearch';


const SYSTEM_MESSAGE_PROMPT = `You are an AI coach designed to help people achieve their health and fitness goals. Answer questions by referencing the knowledge base provided below. If there isn't enough information in the sources, say you don't know. Do not generate answers that don't use the provided sources. 

For any recommendations, always cite the specific source of information using square brackets, for example: [document1.pdf]. List each source separately, don't combine them, for example: [document1.pdf][document2.pdf].

Your answers should always be backed by relevant information from the sources. Always reference the sources. You can ask a follow up question but reserve that for the most needed cases. 

The ideal response should give the user exactly what they need to know - nothing more, nothing less. To emphasize, be concise. 
`;


export class ChatService {
  tokenLimit: number = 4000;

  constructor(
    private config: AppConfig,
    private model: BaseChatModel,
    private vectorStore: VectorStore,
  ) {}

  async run(messages: AIChatMessage[]): Promise<AIChatCompletion> {

    // TODO: implement Retrieval Augmented Generation (RAG) here
    // Get the content of the last message (the question)
    const query = messages[messages.length - 1].content;

    // Performs a vector similarity search.
    // Embedding for the query is automatically computed
    const documents = await this.vectorStore.similaritySearch(query, 3);

    const results: string[] = [];
    for (const document of documents) {
      const source = document.metadata.source;
      const content = document.pageContent.replaceAll(/[\n\r]+/g, ' ');
      results.push(`${source}: ${content}`);
    }

    const content = results.join('\n');

    // Set the context with the system message
    const systemMessage = SYSTEM_MESSAGE_PROMPT;

    // Get the latest user message (the question), and inject the sources into it
    const userMessage = `${messages[messages.length - 1].content}\n\nSources:\n${content}`;

    // Create the messages prompt
    const messageBuilder = new MessageBuilder(systemMessage, this.config.azureOpenAiApiModelName);
    messageBuilder.appendMessage('user', userMessage);

    // Add the previous messages to the prompt, as long as we don't exceed the token limit
    for (const historyMessage of messages.slice(0, -1).reverse()) {
      if (messageBuilder.tokens > this.tokenLimit) {
        messageBuilder.popMessage();
        break;
      }
      messageBuilder.appendMessage(historyMessage.role, historyMessage.content);
    }

    // Processing details, for debugging purposes
    const conversation = messageBuilder.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const thoughts = `Search query:\n${query}\n\nConversation:\n${conversation}`.replaceAll('\n', '<br>');

    const completion = await this.model.invoke(messageBuilder.getMessages());

    // Return the response in the Chat specification format
    return {
      message: {
        content: completion.content as string,
        role: 'assistant',
      },
      context: {
        data_points: results,
        thoughts: thoughts,
      },
    };


  }
}

export default fp(
  async (fastify, options) => {
    const config = fastify.config;

    // Use the current user identity to authenticate.
    // No secrets needed, it uses `az login` or `azd auth login` locally,
    // and managed identity when deployed on Azure.
    const credentials = new DefaultAzureCredential();

    // Set up OpenAI token provider
    const getToken = getBearerTokenProvider(credentials, 'https://cognitiveservices.azure.com/.default');
    const azureADTokenProvider = async () => {
      try {
        return await getToken();
      } catch {
        // Azure identity is not supported in local container environment,
        // so we use a dummy key (only works when using an OpenAI proxy).
        fastify.log.warn('Failed to get Azure OpenAI token, using dummy key');
        return '__dummy';
      }
    };

    // Set up LangChain.js clients
    fastify.log.info(`Using OpenAI at ${config.azureOpenAiApiEndpoint}`);

    const model = new AzureChatOpenAI({
      azureADTokenProvider,
      // Only needed because we make the OpenAI endpoint configurable
      azureOpenAIBasePath: `${config.azureOpenAiApiEndpoint}/openai/deployments`,
      // Controls randomness. 0 = deterministic, 1 = maximum randomness
      temperature: 0.7,
      // Maximum number of tokens to generate
      maxTokens: 1024,
      // Number of completions to generate
      n: 1,
    });
    const embeddings = new AzureOpenAIEmbeddings({
      azureADTokenProvider,
      // Only needed because we make the OpenAI endpoint configurable
      azureOpenAIBasePath: `${config.azureOpenAiApiEndpoint}/openai/deployments`,
    });
    const vectorStore = new AzureAISearchVectorStore(embeddings, { credentials });

    const chatService = new ChatService(config, model, vectorStore);

    fastify.decorate('chat', chatService);
  },
  {
    name: 'chat',
    dependencies: ['config'],
  },
);

// When using .decorate you have to specify added properties for Typescript
declare module 'fastify' {
  export interface FastifyInstance {
    chat: ChatService;
  }
}

