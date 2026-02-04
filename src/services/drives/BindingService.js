import { DriveProviderFactory } from "./DriveProviderFactory.js";
import { DriveRepository } from "../../repositories/DriveRepository.js";
import { SettingsRepository } from "../../repositories/SettingsRepository.js";
import { SessionManager } from "../../modules/SessionManager.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('BindingService') : logger;

/**
 * Service handling the business logic of drive binding and management.
 * Does not depend on Telegram UI.
 */
export class BindingService {
    /**
     * Set a drive as default for a user
     */
    static async setDefaultDrive(userId, driveId) {
        await SettingsRepository.set(`default_drive_${userId}`, driveId);
        return { success: true };
    }

    /**
     * Delete a drive
     */
    static async unbindDrive(userId, driveId) {
        await DriveRepository.delete(driveId);
        // If it was default, clear it
        const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
        if (defaultDriveId === driveId) {
            await SettingsRepository.set(`default_drive_${userId}`, null);
        }
        return { success: true };
    }

    /**
     * Start the binding process for a specific drive type
     */
    static async startBinding(userId, driveType) {
        if (!DriveProviderFactory.isSupported(driveType)) {
            return { success: false, error: 'unsupported_type' };
        }

        const provider = DriveProviderFactory.create(driveType);
        const steps = provider.getBindingSteps();

        if (steps.length === 0) {
            return { success: false, error: 'no_steps' };
        }

        const firstStep = steps[0];
        // Use colon separator for new sessions
        const sessionStep = `${driveType.toUpperCase()}:${firstStep.step}`;
        await SessionManager.start(userId, sessionStep);

        return {
            success: true,
            driveType,
            step: firstStep.step,
            prompt: firstStep.prompt
        };
    }

    /**
     * Process user input during binding
     */
    static async handleInput(userId, session, text) {
        const step = session.current_step;
        if (!step) return { success: false, error: 'no_active_session' };

        let driveType, stepName;

        // Parse step: format is "DRIVETYPE:STEP" or legacy "DRIVETYPE_STEP"
        if (step.includes(':')) {
            const parts = step.split(':');
            driveType = parts[0].toLowerCase();
            stepName = parts.slice(1).join(':');
        } else {
            // Legacy format support
            const supportedTypes = DriveProviderFactory.getSupportedTypes();
            let matchedType = null;
            for (const type of supportedTypes) {
                if (step.toUpperCase().startsWith(type.toUpperCase() + "_")) {
                    matchedType = type;
                    stepName = step.slice(type.length + 1);
                    break;
                }
            }
            if (!matchedType) return { success: false, error: 'invalid_session_format' };
            driveType = matchedType.toLowerCase();
        }

        if (!DriveProviderFactory.isSupported(driveType)) {
            return { success: false, error: 'unsupported_type' };
        }

        const sessionData = session.temp_data ? JSON.parse(session.temp_data) : {};
        const providerSession = { ...session, data: sessionData };

        const provider = DriveProviderFactory.create(driveType);
        const bindingSteps = provider.getBindingSteps();
        const isFinalStep = bindingSteps?.[bindingSteps.length - 1]?.step === stepName;

        try {
            const result = await provider.handleInput(stepName, text, providerSession);

            if (!result.success) {
                if (isFinalStep) {
                    await SessionManager.clear(userId);
                }
                return { ...result, driveType, isFinalStep };
            }

            if (result.nextStep) {
                // Keep using colon separator for next steps
                await SessionManager.update(userId, `${driveType.toUpperCase()}:${result.nextStep}`, result.data);
                return { ...result, driveType, isFinalStep: false };
            }

            // Final success - create the drive
            const configData = result.data;
            const driveName = `${driveType.charAt(0).toUpperCase() + driveType.slice(1)}-${configData.user}`;

            await DriveRepository.create(userId, driveName, driveType, configData);
            await SessionManager.clear(userId);

            return { ...result, driveType, isFinalStep: true, driveName };
        } catch (error) {
            log.error(`Error in BindingService.handleInput for ${driveType}:`, error);
            return { success: false, error: 'internal_error', message: error.message };
        }
    }
}
