"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createObservableWorker = createObservableWorker;
const bullmq_1 = require("bullmq");
const Sentry = __importStar(require("@sentry/node"));
const request_context_1 = require("@guestpost/shared/dist/observability/request-context");
function extractRequestId(job) {
    if (!job)
        return undefined;
    const data = job.data;
    const id = data?.requestId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}
function createObservableWorker(queueName, processor, opts) {
    const wrappedProcessor = async (job, token) => {
        const requestId = extractRequestId(job);
        const run = async () => {
            return Sentry.withScope(async (scope) => {
                scope.setTag("queue", queueName);
                if (job?.id)
                    scope.setTag("jobId", String(job.id));
                if (requestId)
                    scope.setTag("requestId", requestId);
                return processor(job, token);
            });
        };
        if (requestId) {
            return (0, request_context_1.runWithRequestId)(requestId, run);
        }
        return run();
    };
    const worker = new bullmq_1.Worker(queueName, wrappedProcessor, opts);
    worker.on("failed", (job, err) => {
        const requestId = extractRequestId(job);
        Sentry.withScope((scope) => {
            scope.setTag("queue", queueName);
            if (job?.id)
                scope.setTag("jobId", String(job.id));
            if (job?.attemptsMade != null)
                scope.setTag("attemptsMade", String(job.attemptsMade));
            if (requestId)
                scope.setTag("requestId", requestId);
            Sentry.captureException(err);
        });
        console.error(`[OBSERVABILITY] captured job failure: queue=${queueName} jobId=${job?.id ?? "?"} attempts=${job?.attemptsMade ?? "?"} requestId=${requestId ?? "-"} err=${err.message}`);
    });
    worker.on("error", (err) => {
        Sentry.withScope((scope) => {
            scope.setTag("queue", queueName);
            scope.setTag("source", "worker-error");
            Sentry.captureException(err);
        });
        console.error(`[OBSERVABILITY] worker error: queue=${queueName} err=${err.message}`);
    });
    worker.on("stalled", (jobId) => {
        console.warn(`[OBSERVABILITY] job stalled: queue=${queueName} jobId=${jobId}`);
    });
    return worker;
}
//# sourceMappingURL=queue-observability.js.map