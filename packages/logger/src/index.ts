export { createLogger, type Logger, type LoggerOptions } from "./logger.js";
export { withContext, enterContext, getContext, type LogContext } from "./context.js";
export { DEFAULT_REDACTION_PATHS } from "./redaction.js";
export {
  correlationPlugin,
  correlationHook,
  type CorrelationPluginOptions,
  type CorrelationHook,
} from "./fastify-plugin.js";
