#!/usr/bin/env node

import { cleanupConfigResources, initConfig, getConfig } from "../src/config/index.js";
import { d1 } from "../src/services/d1.js";
import { logger } from "../src/services/logger/index.js";
import {
    assertDatabaseSchemaCurrent,
    formatDatabaseSchemaStatus,
    getDatabaseSchemaStatus,
    migrateDatabaseSchema
} from "../src/database/schema.js";

function parseArgs(argv) {
    return {
        check: argv.includes("--check"),
        status: argv.includes("--status"),
        dryRun: argv.includes("--dry-run"),
        noLock: argv.includes("--no-lock")
    };
}

function printMigrationResults(results = []) {
    for (const result of results) {
        const duration = result.executionTimeMs === undefined ? "" : ` (${result.executionTimeMs}ms)`;
        console.log(`- ${result.version}:${result.name} ${result.action}${duration}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await initConfig();
    const config = getConfig();

    if (!config.d1?.accountId || !config.d1?.databaseId || !config.d1?.token) {
        throw new Error("D1 configuration is incomplete. Set CLOUDFLARE_D1_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_D1_TOKEN.");
    }

    await d1.initialize();

    if (args.status) {
        const status = await getDatabaseSchemaStatus({ d1 });
        console.log(formatDatabaseSchemaStatus(status));
        return;
    }

    if (args.check) {
        const status = await assertDatabaseSchemaCurrent({ d1 });
        console.log(formatDatabaseSchemaStatus(status));
        return;
    }

    const migrationResult = await migrateDatabaseSchema({
        d1,
        log: logger.withModule ? logger.withModule("DBMigration") : logger,
        dryRun: args.dryRun,
        useLock: !args.noLock,
        lockTtlMs: config.database?.migrationLockTtlMs,
        lockWaitMs: config.database?.migrationLockWaitMs
    });

    printMigrationResults(migrationResult.results);

    if (migrationResult.status) {
        console.log(formatDatabaseSchemaStatus(migrationResult.status));
    }
}

main()
    .catch(error => {
        console.error(`Database migration failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(() => {
        cleanupConfigResources();
    });
