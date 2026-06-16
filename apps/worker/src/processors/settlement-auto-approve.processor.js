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
exports.__internals = void 0;
exports.createSettlementAutoApproveWorker = createSettlementAutoApproveWorker;
const Sentry = __importStar(require("@sentry/node"));
const shared_1 = require("@guestpost/shared");
const database_1 = require("@guestpost/database");
const redis_1 = require("../redis");
const queue_observability_1 = require("../lib/queue-observability");
const SLOW_SWEEP_DEFAULT_MS = 30_000;
let runsTotal = 0;
function createSettlementAutoApproveWorker() {
    return (0, queue_observability_1.createObservableWorker)(shared_1.QUEUES.SETTLEMENT, async (job) => {
        if (!(0, shared_1.verifyJobPayload)(job.data)) {
            console.error(`[SETTLEMENT_AUTO_APPROVE] Job ${job.id} has missing/invalid signature — rejecting`);
            throw new Error("Invalid job signature");
        }
        if (job.name !== "settlement-auto-approve") {
            console.warn(`[SETTLEMENT_AUTO_APPROVE] Unexpected job name '${job.name}' — skipping`);
            return;
        }
        const batchSize = clampBatchSize(job.data.batchSize);
        const slowMs = Math.max(Number(process.env.SETTLEMENT_AUTO_APPROVE_SLOW_MS) || SLOW_SWEEP_DEFAULT_MS, 1000);
        runsTotal++;
        const result = await (0, shared_1.runSettlementAutoApprove)(database_1.prisma, { batchSize });
        const stale = await (0, shared_1.countStaleReviewSettlements)(database_1.prisma);
        console.log(`[SETTLEMENT_AUTO_APPROVE] runs_total=${runsTotal} scanned=${result.scanned} approved=${result.approved} skipped=${result.skipped} stale=${stale} duration_ms=${result.durationMs}`);
        if (result.durationMs > slowMs) {
            Sentry.captureMessage("Settlement auto-approve sweep slow", {
                level: "warning",
                extra: {
                    duration_ms: result.durationMs,
                    slow_threshold_ms: slowMs,
                    scanned: result.scanned,
                    approved: result.approved,
                    batch_size: batchSize,
                },
            });
        }
        if (stale > 0) {
            Sentry.captureMessage("Stale settlement review windows detected", {
                level: "warning",
                extra: { count: stale, stale_threshold_hours: 24 },
            });
        }
    }, { connection: redis_1.connection, concurrency: 1 });
}
function clampBatchSize(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return 100;
    const rounded = Math.floor(value);
    if (rounded < 1)
        return 1;
    if (rounded > 10_000)
        return 10_000;
    return rounded;
}
exports.__internals = { clampBatchSize };
//# sourceMappingURL=settlement-auto-approve.processor.js.map