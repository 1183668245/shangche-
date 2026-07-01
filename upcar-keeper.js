import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;

const CHAIN_ID = Number(env.CHAIN_ID || 97);
const RPC_URL = CHAIN_ID === 97 ? env.RPC_URL_TESTNET || "" : CHAIN_ID === 56 ? env.RPC_URL || "" : "";
const PRIVATE_KEY = env.PRIVATE_KEY || "";
const VAULT_ADDRESS = env.UPCAR_VAULT_ADDRESS || env.VAULT_ADDRESS || "";
const POLL_INTERVAL_MS = Number(env.POLL_INTERVAL_MS || 20000);
const DRY_RUN = (env.KEEPER_ENABLE_WRITE || "").toLowerCase() !== "true";

if (![56, 97].includes(CHAIN_ID)) throw new Error("CHAIN_ID 仅支持 56 或 97");
if (!RPC_URL) throw new Error(CHAIN_ID === 97 ? "缺少 RPC_URL_TESTNET" : "缺少 RPC_URL");
if (!PRIVATE_KEY) throw new Error("缺少 PRIVATE_KEY");
if (!VAULT_ADDRESS) throw new Error("缺少 UPCAR_VAULT_ADDRESS 或 VAULT_ADDRESS");

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
let isBusy = false;

const vaultAbi = parseAbi([
  "function dashboardDisplayStats() view returns ((uint256 realtimePool,uint256 stagedPool,uint256 stakingPool,uint256 luckyPool,uint256 marketCapNative,uint256 marketCapUsd,uint8 currentStageToTrigger,bool taxRedirectedAfter500k,bool realtimeExecutable))",
  "function realtimeCountdownStart() view returns (uint64)",
  "function REALTIME_COUNTDOWN() view returns (uint256)",
  "function REALTIME_MIN() view returns (uint256)",
  "function executor() view returns (address)",
  "function stageRuntime(uint8) view returns (bool triggered,bool completed,uint8 executedBatches,uint64 snapshotAt,uint64 lastBatchAt,uint256 snapshotAmount,uint256 batchAmount,uint256 releasedAmount)",
  "function STAGE_MIN_TRIGGER() view returns (uint256)",
  "function STAGE_BATCHES() view returns (uint8)",
  "function STAGE_BATCH_INTERVAL() view returns (uint256)",
  "function startRealtimeCountdown()",
  "function executeRealtimeBuyback() returns (uint256)",
  "function executeRealtimeBuybackWithOracleProof(uint112,uint112,uint32,bytes) returns (uint256)",
  "function triggerStage(uint8) returns (uint256)",
  "function triggerStageWithOracleProof(uint8,uint112,uint112,uint32,bytes) returns (uint256)",
  "function executeStageBatch(uint8) returns (uint256)",
  "function executeStageBatchWithOracleProof(uint8,uint112,uint112,uint32,bytes) returns (uint256)",
  "error PairMissing()",
  "error DexNotLive()",
  "error ZeroTokenBought()",
  "error OracleProofStale()",
  "error BadOracleProof()",
  "error OraclePriceDeviationTooHigh()",
  "error OracleUnsupportedForPortal()",
]);

const executorAbi = parseAbi([
  "function isDexLive() view returns (bool)",
  "function resolvedLpPair() view returns (address)",
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function shortBnb(current, target) {
  const diff = target > current ? target - current : 0n;
  return `${fmt(current)} / ${fmt(target)} BNB，还差 ${fmt(diff)} BNB`;
}

function shortUsd(current, target) {
  const diff = target > current ? target - current : 0n;
  return `${fmt(current)} / ${fmt(target)} USD，还差 ${fmt(diff)} USD`;
}

function fmt(v) {
  try {
    return formatEther(BigInt(v));
  } catch {
    return String(v);
  }
}

function stageTargetUsd(stageId) {
  if (stageId === 1) return 50_000n * 10n ** 18n;
  if (stageId === 2) return 100_000n * 10n ** 18n;
  if (stageId === 3) return 150_000n * 10n ** 18n;
  if (stageId === 4) return 250_000n * 10n ** 18n;
  if (stageId === 5) return 500_000n * 10n ** 18n;
  return 0n;
}

function normalizeStageRuntime(v) {
  return {
    triggered: Boolean(v?.triggered ?? v?.[0]),
    completed: Boolean(v?.completed ?? v?.[1]),
    executedBatches: Number(v?.executedBatches ?? v?.[2] ?? 0),
    snapshotAt: BigInt(v?.snapshotAt ?? v?.[3] ?? 0),
    lastBatchAt: BigInt(v?.lastBatchAt ?? v?.[4] ?? 0),
    snapshotAmount: BigInt(v?.snapshotAmount ?? v?.[5] ?? 0),
    batchAmount: BigInt(v?.batchAmount ?? v?.[6] ?? 0),
    releasedAmount: BigInt(v?.releasedAmount ?? v?.[7] ?? 0),
  };
}

async function fetchOracleProof(pool, chainId) {
  const oracleUrl =
    env.ORACLE_POOL_PROOF_URL ||
    (chainId === 97
      ? "https://oracle-testnet.taxed.fun/v2-pool-reserves"
      : "https://oracle.taxed.fun/v2-pool-reserves");

  const url = `${oracleUrl}?pool=${pool}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Oracle 请求失败: ${res.status} ${res.statusText}`);
  }

  const proof = await res.json();
  const reserve0 = BigInt(String(proof.oracleReserve0 ?? proof.reserve0 ?? 0));
  const reserve1 = BigInt(String(proof.oracleReserve1 ?? proof.reserve1 ?? 0));
  const timestamp = Number(proof.oracleTimestamp ?? proof.timestamp ?? 0);
  const signature = proof.oracleSignature ?? proof.signature ?? "0x";

  if (reserve0 <= 0n || reserve1 <= 0n) throw new Error("Oracle reserve 无效");
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Oracle timestamp 无效");
  if (!signature || signature === "0x") throw new Error("Oracle signature 缺失");

  return {
    reserve0,
    reserve1,
    timestamp,
    signature,
  };
}

async function writeViaSimulation(functionName, args) {
  const simulation = await publicClient.simulateContract({
    account,
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName,
    args,
  });

  if (DRY_RUN) {
    log("[DRY_RUN]", functionName, JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    return null;
  }

  const hash = await walletClient.writeContract(simulation.request);
  log("tx sent:", functionName, hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  log("tx confirmed:", functionName, receipt.transactionHash);
  return receipt;
}

async function readSnapshot() {
  const chainId = await publicClient.getChainId();
  const stats = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "dashboardDisplayStats",
  });

  const realtimeCountdownStart = BigInt(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "realtimeCountdownStart",
    }),
  );

  const realtimeCountdownDuration = BigInt(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "REALTIME_COUNTDOWN",
    }),
  );

  const realtimeMin = BigInt(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "REALTIME_MIN",
    }),
  );

  const executor = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "executor",
  });

  const dexLive = await publicClient.readContract({
    address: executor,
    abi: executorAbi,
    functionName: "isDexLive",
  });

  const stageId = Number(stats.currentStageToTrigger ?? stats[6] ?? 0);

  const rawStageRuntime = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "stageRuntime",
    args: [stageId],
  });

  const stageMinTrigger = BigInt(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "STAGE_MIN_TRIGGER",
    }),
  );

  const stageBatches = Number(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "STAGE_BATCHES",
    }),
  );

  const stageBatchInterval = BigInt(
    await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: "STAGE_BATCH_INTERVAL",
    }),
  );

  return {
    chainId,
    executor,
    dexLive,
    stageId,
    stageRuntime: normalizeStageRuntime(rawStageRuntime),
    stageMinTrigger,
    stageBatches,
    stageBatchInterval,
    realtimeCountdownStart,
    realtimeCountdownDuration,
    realtimeMin,
    realtimePool: BigInt(stats.realtimePool ?? stats[0] ?? 0),
    stagedPool: BigInt(stats.stagedPool ?? stats[1] ?? 0),
    marketCapUsd: BigInt(stats.marketCapUsd ?? stats[5] ?? 0),
    realtimeExecutable: Boolean(stats.realtimeExecutable ?? stats[8]),
  };
}

async function realtimeJob(snapshot) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const countdownEnd = snapshot.realtimeCountdownStart + snapshot.realtimeCountdownDuration;
  const countdownStarted = snapshot.realtimeCountdownStart > 0n;
  const countdownFinished = countdownStarted && now >= countdownEnd;
  const countdownRemaining = countdownStarted && now < countdownEnd ? countdownEnd - now : 0n;

  log(
    "[实时回购]",
    shortBnb(snapshot.realtimePool, snapshot.realtimeMin),
    `倒计时${countdownStarted ? "已开启" : "未开启"}`,
    `剩余 ${countdownRemaining.toString()}s`,
    `可执行 ${snapshot.realtimeExecutable ? "是" : "否"}`,
  );

  if (snapshot.realtimePool >= snapshot.realtimeMin && snapshot.realtimeCountdownStart === 0n) {
    log("[实时回购] 已达门槛，准备开启倒计时");
    await writeViaSimulation("startRealtimeCountdown", []);
    return true;
  }

  if (snapshot.realtimeExecutable || countdownFinished) {
    if (!snapshot.dexLive) {
      log("[实时回购] DEX 未上线，直接执行普通回购");
      await writeViaSimulation("executeRealtimeBuyback", []);
      return true;
    }

    log("[实时回购] 已进入执行阶段，开始检查 LP 与 Oracle");
    const pool = await publicClient.readContract({
      address: snapshot.executor,
      abi: executorAbi,
      functionName: "resolvedLpPair",
    });

    log("[实时回购] resolvedLpPair=", pool);
    if (!pool || /^0x0{40}$/i.test(pool)) {
      log("[实时回购] DEX 池未就绪，先跳过");
      return;
    }

    log("[实时回购] 开始拉取 Oracle 证明");
    const proof = await fetchOracleProof(pool, snapshot.chainId);
    log("[实时回购] Oracle 证明已拿到，准备执行回购");
    try {
      await writeViaSimulation("executeRealtimeBuybackWithOracleProof", [
        proof.reserve0,
        proof.reserve1,
        proof.timestamp,
        proof.signature,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BadOracleProof()")) throw err;
      log("[实时回购] Oracle proof 校验失败，降级为普通回购");
      await writeViaSimulation("executeRealtimeBuyback", []);
    }
    return true;
  }

  log("[实时回购] 当前无需操作");
  return false;
}

async function stageJob(snapshot) {
  const stageId = snapshot.stageId;
  if (!stageId) {
    log("[stage] 所有阶段已完成");
    return;
  }

  const targetUsd = stageTargetUsd(stageId);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownEnd = snapshot.stageRuntime.lastBatchAt + snapshot.stageBatchInterval;
  const batchCooldownFinished =
    snapshot.stageRuntime.lastBatchAt === 0n || now >= cooldownEnd;

  log(
    `[阶段回购·第 ${stageId} 站]`,
    `DEX ${snapshot.dexLive ? "已上线" : "未上线"}`,
    `阶段池 ${shortBnb(snapshot.stagedPool, snapshot.stageMinTrigger)}`,
    `市值 ${shortUsd(snapshot.marketCapUsd, targetUsd)}`,
    `批次 ${snapshot.stageRuntime.executedBatches}/${snapshot.stageBatches}`,
  );

  if (
    snapshot.dexLive &&
    !snapshot.stageRuntime.triggered &&
    snapshot.stagedPool >= snapshot.stageMinTrigger &&
    snapshot.marketCapUsd >= targetUsd
  ) {
    const pool = await publicClient.readContract({
      address: snapshot.executor,
      abi: executorAbi,
      functionName: "resolvedLpPair",
    });

    if (!pool || /^0x0{40}$/i.test(pool)) {
      log(`[阶段回购·第 ${stageId} 站] DEX 池未就绪，先跳过`);
      return;
    }

    const proof = await fetchOracleProof(pool, snapshot.chainId);
    log(`[阶段回购·第 ${stageId} 站] 已达标，准备触发`);
    try {
      await writeViaSimulation("triggerStageWithOracleProof", [
        stageId,
        proof.reserve0,
        proof.reserve1,
        proof.timestamp,
        proof.signature,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BadOracleProof()")) throw err;
      log(`[阶段回购·第 ${stageId} 站] Oracle proof 校验失败，降级为普通触发`);
      await writeViaSimulation("triggerStage", [stageId]);
    }
    return true;
  }

  if (
    snapshot.dexLive &&
    snapshot.stageRuntime.triggered &&
    !snapshot.stageRuntime.completed &&
    snapshot.stageRuntime.executedBatches < snapshot.stageBatches &&
    batchCooldownFinished
  ) {
    const pool = await publicClient.readContract({
      address: snapshot.executor,
      abi: executorAbi,
      functionName: "resolvedLpPair",
    });

    if (!pool || /^0x0{40}$/i.test(pool)) {
      log(`[阶段回购·第 ${stageId} 站] DEX 池未就绪，先跳过本批`);
      return;
    }

    const proof = await fetchOracleProof(pool, snapshot.chainId);
    log(`[阶段回购·第 ${stageId} 站] 准备执行下一批`);
    try {
      await writeViaSimulation("executeStageBatchWithOracleProof", [
        stageId,
        proof.reserve0,
        proof.reserve1,
        proof.timestamp,
        proof.signature,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BadOracleProof()")) throw err;
      log(`[阶段回购·第 ${stageId} 站] Oracle proof 校验失败，降级为普通批次执行`);
      await writeViaSimulation("executeStageBatch", [stageId]);
    }
    return true;
  }

  log("[stage] 当前无需操作");
  return false;
}

async function mainLoop() {
  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== CHAIN_ID) {
    throw new Error(`RPC 链 ID 不匹配：配置=${CHAIN_ID}，实际=${connectedChainId}`);
  }

  log(`keeper start, chainId=${CHAIN_ID}, vault=${VAULT_ADDRESS}, dryRun=${DRY_RUN}, interval=${POLL_INTERVAL_MS}ms`);

  while (true) {
    if (isBusy) {
      log("[keeper] 上一轮仍在处理中，跳过本轮");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    isBusy = true;
    try {
      const snapshot = await readSnapshot();
      const realtimeHandled = await realtimeJob(snapshot);
      if (realtimeHandled) {
        log("[keeper] 本轮已执行实时回购相关交易，阶段回购顺延到下一轮");
      } else {
        const stageHandled = await stageJob(snapshot);
        if (stageHandled) {
          log("[keeper] 本轮已执行阶段回购相关交易");
        }
      }
    } catch (err) {
      log("[keeper:error]", err instanceof Error ? err.message : String(err));
    } finally {
      isBusy = false;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

mainLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});