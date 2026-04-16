/**
 * Settings Tab Module
 *
 * Provides the plugin settings UI with sections for:
 * - Connection (S3 provider configuration)
 * - Encryption (E2E encryption settings)
 * - Sync (synchronization options)
 * - Backup (backup scheduling and retention)
 * - Advanced (debug logging, exclude patterns)
 */

import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type S3SyncBackupPlugin from './main';
import {
	S3ProviderType,
	S3_PROVIDER_NAMES,
	SyncIntervalMinutes,
	BackupInterval,
	BACKUP_INTERVAL_NAMES,
	RetentionMode,
} from './types';
import { S3Provider } from './storage/S3Provider';
import { normalizePrefix } from './utils/paths';
import { validatePassphrase } from './crypto/KeyDerivation';

/**
 * Sync interval display names for dropdown.
 *
 * Maps each allowed sync interval (in minutes) to a human-readable label shown in
 * the settings UI. The keys are the numeric `SyncIntervalMinutes` union values and
 * must stay in sync with that type. Stored as a module-level constant so it is
 * only allocated once regardless of how many times the settings tab is rendered.
 */
const SYNC_INTERVAL_NAMES: Record<SyncIntervalMinutes, string> = {
	1: '1 minute',
	2: '2 minutes',
	5: '5 minutes',
	10: '10 minutes',
	15: '15 minutes',
	30: '30 minutes',
};

/**
 * S3SyncBackupSettingTab — Obsidian settings UI for the plugin.
 *
 * Extends `PluginSettingTab` to render a multi-section configuration panel
 * inside Obsidian's native Settings modal. Sections are rendered in separate
 * private methods (Connection, Encryption, Sync, Backup, Advanced) to keep
 * `display()` readable and each domain concern self-contained.
 *
 * Provider-conditional fields (endpoint URL, force-path-style) are shown or
 * hidden by calling `this.display()` on provider change, which fully re-renders
 * the panel with the current settings state.
 */
export class S3SyncBackupSettingTab extends PluginSettingTab {
	plugin: S3SyncBackupPlugin;
	private testConnectionButton: HTMLButtonElement | null = null;

	/**
	 * @param app    - The Obsidian application instance.
	 * @param plugin - The plugin instance that owns this settings tab.
	 */
	constructor(app: App, plugin: S3SyncBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Add custom CSS class for styling
		containerEl.addClass('s3-sync-backup-settings');

		this.renderConnectionSection(containerEl);
		this.renderEncryptionSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderBackupSection(containerEl);
		this.renderAdvancedSection(containerEl);
	}

	/**
	 * Render the Connection settings section.
	 *
	 * Renders provider dropdown plus provider-conditional fields: endpoint URL
	 * (hidden for AWS), force-path-style toggle (shown only for MinIO and custom),
	 * and the "Test connection" button. Changing the provider calls `this.display()`
	 * to fully re-render so conditional fields appear or disappear immediately.
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderConnectionSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Connection').setHeading();

		// Provider selection
		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Select your S3-compatible storage provider')
			.addDropdown((dropdown) => {
				// Add all provider options
				for (const [value, name] of Object.entries(S3_PROVIDER_NAMES)) {
					dropdown.addOption(value, name);
				}
				dropdown.setValue(this.plugin.settings.provider);
				dropdown.onChange(async (value) => {
					this.plugin.settings.provider = value as S3ProviderType;
					await this.plugin.saveSettings();
					// Refresh to show/hide provider-specific fields
					this.display();
				});
			});

		// Endpoint URL (shown for non-AWS providers)
		if (this.plugin.settings.provider !== 'aws') {
			const endpointDesc = this.getEndpointDescription();
			new Setting(containerEl)
				.setName('Endpoint URL')
				.setDesc(endpointDesc)
				.addText((text) => {
					text.setPlaceholder(this.getEndpointPlaceholder());
					text.setValue(this.plugin.settings.endpoint);
					text.onChange(async (value) => {
						this.plugin.settings.endpoint = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// Region
		new Setting(containerEl)
			.setName('Region')
			.setDesc(this.plugin.settings.provider === 'r2' ? 'Use "auto" for Cloudflare R2' : 'AWS region (e.g., us-east-1)')
			.addText((text) => {
				text.setPlaceholder(this.plugin.settings.provider === 'r2' ? 'auto' : 'us-east-1');
				text.setValue(this.plugin.settings.region);
				text.onChange(async (value) => {
					this.plugin.settings.region = value;
					await this.plugin.saveSettings();
				});
			});

		// Bucket name
		new Setting(containerEl)
			.setName('Bucket')
			.setDesc('Name of your S3 bucket')
			.addText((text) => {
				text.setPlaceholder('my-bucket');
				text.setValue(this.plugin.settings.bucket);
				text.onChange(async (value) => {
					this.plugin.settings.bucket = value;
					await this.plugin.saveSettings();
				});
			});

		// Access Key ID
		new Setting(containerEl)
			.setName('Access key ID')
			.setDesc('Your S3 access key ID')
			.addText((text) => {
				text.setPlaceholder('AKIAIOSFODNN7EXAMPLE');
				text.setValue(this.plugin.settings.accessKeyId);
				text.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.accessKeyId = value;
					await this.plugin.saveSettings();
				});
			});

		// Secret Access Key
		new Setting(containerEl)
			.setName('Secret access key')
			.setDesc('Your S3 secret access key')
			.addText((text) => {
				text.setPlaceholder('your-secret-key');
				text.setValue(this.plugin.settings.secretAccessKey);
				text.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.secretAccessKey = value;
					await this.plugin.saveSettings();
				});
			});

		// Force Path Style (for MinIO and custom providers)
		if (this.plugin.settings.provider === 'minio' || this.plugin.settings.provider === 'custom') {
			new Setting(containerEl)
				.setName('Force path style')
				.setDesc('Use path-style URLs (required for MinIO and some S3 compatible services)')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.forcePathStyle);
					toggle.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// Test Connection button
		const testConnectionSetting = new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify your S3 credentials and bucket access');

		testConnectionSetting.addButton((button) => {
			this.testConnectionButton = button.buttonEl;
			button.setButtonText('Test connection');
			button.onClick(async () => {
				await this.testConnection(button.buttonEl);
			});
		});
	}

	/**
	 * Return a human-readable description for the endpoint URL field.
	 *
	 * Each provider has a distinct URL format, so the description gives provider-
	 * specific guidance (e.g., the R2 account-ID URL pattern).
	 *
	 * @returns A localized description string appropriate for the current provider.
	 */
	private getEndpointDescription(): string {
		switch (this.plugin.settings.provider) {
			case 'r2':
				return 'Your R2 endpoint URL (https://<ACCOUNT_ID>.r2.cloudflarestorage.com)';
			case 'minio':
				return 'Your MinIO server URL (e.g., http://localhost:9000)';
			case 'custom':
				return 'Your S3-compatible endpoint URL';
			default:
				return 'S3 endpoint URL';
		}
	}

	/**
	 * Return the placeholder text for the endpoint URL input field.
	 *
	 * Provides a concrete example URL so users know the expected format for their
	 * chosen provider (e.g., the MinIO localhost URL pattern).
	 *
	 * @returns A provider-specific example URL string, or an empty string for AWS
	 *   (endpoint not shown for AWS).
	 */
	private getEndpointPlaceholder(): string {
		switch (this.plugin.settings.provider) {
			case 'r2':
				return 'https://abc123.r2.cloudflarestorage.com';
			case 'minio':
				return 'http://localhost:9000';
			case 'custom':
				return 'https://s3.example.com';
			default:
				return '';
		}
	}

	/**
	 * Test the configured S3 connection and report the result to the user.
	 *
	 * Creates a temporary, isolated `S3Provider` with the current settings (does not
	 * reuse the plugin's shared provider) and calls `testConnection()`. Disables the
	 * button during the test to prevent concurrent requests. Displays a `Notice` with
	 * the success message or error, and resets the button text after a short delay.
	 *
	 * @param buttonEl - The "Test connection" button element to update during the test.
	 * @returns A promise that resolves when the test completes and UI is updated.
	 */
	private async testConnection(buttonEl: HTMLButtonElement): Promise<void> {
		const originalText = buttonEl.textContent || 'Test Connection';
		buttonEl.textContent = 'Testing...';
		buttonEl.disabled = true;

		try {
			const provider = new S3Provider(this.plugin.settings);
			const message = await provider.testConnection();
			provider.destroy();

			new Notice(`✓ ${message}`);
			buttonEl.textContent = '✓ connected';

			// Reset button text after delay
			setTimeout(() => {
				buttonEl.textContent = originalText;
				buttonEl.disabled = false;
			}, 2000);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`✗ ${errorMessage}`);
			buttonEl.textContent = '✗ failed';
			buttonEl.disabled = false;

			// Reset button text after delay
			setTimeout(() => {
				buttonEl.textContent = originalText;
			}, 2000);
		}
	}

	/**
	 * Render the Encryption settings section.
	 *
	 * The UI state is derived from the EncryptionCoordinator's runtime state:
	 * - Plaintext + no key → show "Enable encryption" toggle + passphrase field
	 * - Encrypted + no key → show "Unlock" passphrase field (vault locked)
	 * - Encrypted + key loaded → show "Encryption active" status + disable button
	 * - Transitioning → show migration status message
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderEncryptionSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Encryption').setHeading();

		const coordinator = this.plugin.getEncryptionCoordinator();
		const state = coordinator?.getState();

		// State: transitioning (migration in progress on this or another device)
		if (state?.remoteMode === 'transitioning') {
			const noteEl = containerEl.createEl('div', { cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'Encryption state transition in progress. Sync and backup are paused until migration completes.',
			});
			return;
		}

		// State: encrypted but no key loaded (locked — other device enabled, or restart)
		if (state?.remoteMode === 'encrypted' && !state.hasKey) {
			const noteEl = containerEl.createEl('div', { cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'Vault is encrypted. Enter your passphrase to unlock sync and backup.',
			});

			let passphraseValue = '';

			new Setting(containerEl)
				.setName('Passphrase')
				.setDesc('Enter the passphrase used to encrypt this vault')
				.addText((text) => {
					text.setPlaceholder('Enter passphrase...');
					text.inputEl.type = 'password';
					text.onChange((value) => { passphraseValue = value; });
				});

			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Unlock');
					button.setCta();
					button.onClick(async () => {
						if (!passphraseValue) {
							new Notice('Please enter a passphrase');
							return;
						}

						button.setButtonText('Unlocking...');
						button.setDisabled(true);

						try {
							const success = await coordinator?.unlock(passphraseValue);
							if (success) {
								new Notice('Vault unlocked successfully');
								this.display();
							} else {
								new Notice('Incorrect passphrase');
							}
						} catch (error) {
							const msg = error instanceof Error ? error.message : 'Unknown error';
							new Notice(`Unlock failed: ${msg}`);
						} finally {
							button.setButtonText('Unlock');
							button.setDisabled(false);
						}
					});
				});

			return;
		}

		// State: encrypted and key loaded (fully unlocked)
		if (state?.remoteMode === 'encrypted' && state.hasKey) {
			const noteEl = containerEl.createEl('div', { cls: 's3-sync-backup-info' });
			noteEl.createEl('p', {
				text: 'End-to-end encryption is active. All files are encrypted before upload.',
			});

			new Setting(containerEl)
				.setName('Disable encryption')
				.setDesc('Re-upload all files as plaintext and remove encryption')
				.addButton((button) => {
					button.setButtonText('Disable encryption');
					button.setWarning();
					button.onClick(async () => {
						const confirmed = await this.showDisableEncryptionConfirmation();
						if (!confirmed) return;

						button.setButtonText('Disabling...');
						button.setDisabled(true);

						const result = await coordinator?.disableEncryption(
							async () => { await this.plugin.saveSettings(); },
						);

						if (result?.success) {
							this.plugin.onSettingsChanged();
							this.display();
						} else {
							new Notice(`Failed to disable encryption: ${result?.error ?? 'Unknown error'}`);
							button.setButtonText('Disable encryption');
							button.setDisabled(false);
						}
					});
				});

			return;
		}

		// State: plaintext (default — encryption not enabled)
		new Setting(containerEl)
			.setName('Enable end-to-end encryption')
			.setDesc('Encrypt all files before uploading to S3')
			.addToggle((toggle) => {
				toggle.setValue(false);
				toggle.onChange(async (value) => {
					if (value) {
						// Show passphrase entry fields by re-rendering
						this.plugin.settings.encryptionEnabled = true;
						this.display();
					}
				});
			});

		// If the user just toggled ON, show passphrase entry
		if (this.plugin.settings.encryptionEnabled && state?.remoteMode === 'plaintext') {
			const noteEl = containerEl.createEl('div', { cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'This passphrase encrypts both synced files and backups. If lost, your data cannot be recovered.',
			});

			let passphraseValue = '';
			let strengthEl: HTMLElement | null = null;

			new Setting(containerEl)
				.setName('Passphrase')
				.setDesc('Enter a strong passphrase (minimum 8 characters)')
				.addText((text) => {
					text.setPlaceholder('Enter passphrase...');
					text.inputEl.type = 'password';
					text.onChange((value) => {
						passphraseValue = value;
						if (strengthEl) {
							const validation = validatePassphrase(value);
							strengthEl.textContent = value.length === 0
								? ''
								: `Strength: ${validation.strength}${validation.message ? ` — ${validation.message}` : ''}`;
							strengthEl.className = `s3-sync-passphrase-strength s3-sync-strength-${validation.strength}`;
						}
					});
				});

			strengthEl = containerEl.createEl('div', { cls: 's3-sync-passphrase-strength' });

			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Enable encryption');
					button.setCta();
					button.onClick(async () => {
						const validation = validatePassphrase(passphraseValue);
						if (!validation.valid) {
							new Notice(validation.message ?? 'Invalid passphrase');
							return;
						}

						button.setButtonText('Enabling...');
						button.setDisabled(true);

						const result = await coordinator?.enableEncryption(
							passphraseValue,
							async () => { await this.plugin.saveSettings(); },
						);

						if (result?.success) {
							this.plugin.onSettingsChanged();
							this.display();
						} else {
							new Notice(`Failed to enable encryption: ${result?.error ?? 'Unknown error'}`);
							button.setButtonText('Enable encryption');
							button.setDisabled(false);
						}
					});
				});

			// Cancel button to revert the toggle
			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Cancel');
					button.onClick(async () => {
						this.plugin.settings.encryptionEnabled = false;
						await this.plugin.saveSettings();
						this.display();
					});
				});
		}
	}

	/**
	 * Show a confirmation modal before disabling encryption.
	 *
	 * @returns true if the user confirmed, false if cancelled.
	 */
	private showDisableEncryptionConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new DisableEncryptionModal(this.app, resolve);
			modal.open();
		});
	}

	/**
	 * Render the Sync settings section.
	 *
	 * Always shows the "Enable sync" master toggle. When sync is enabled, additional
	 * fields are rendered conditionally: sync prefix, auto-sync toggle, sync interval
	 * (only when auto-sync is on), and sync-on-startup toggle. Toggling the master
	 * switch or auto-sync calls `this.plugin.onSettingsChanged()` to restart services
	 * with the new configuration.
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Enable sync')
			.setDesc('Enable bi-directional vault synchronization')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.syncEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.syncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.display();
				});
			});

		if (this.plugin.settings.syncEnabled) {
			// Sync Prefix
			new Setting(containerEl)
				.setName('Sync prefix')
				.setDesc('S3 path prefix for synced files (e.g., "vault" → s3://bucket/vault/)')
				.addText((text) => {
					text.setPlaceholder('vault');
					text.setValue(this.plugin.settings.syncPrefix);
					text.onChange(async (value) => {
						this.plugin.settings.syncPrefix = normalizePrefix(value) || 'vault';
						await this.plugin.saveSettings();
					});
				});

			// Auto-sync toggle
			new Setting(containerEl)
				.setName('Auto-sync')
				.setDesc('Automatically sync at regular intervals')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.autoSyncEnabled);
					toggle.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.onSettingsChanged();
						this.display();
					});
				});

			// Sync interval (only shown if auto-sync enabled)
			if (this.plugin.settings.autoSyncEnabled) {
				new Setting(containerEl)
					.setName('Sync interval')
					.setDesc('How often to automatically sync')
					.addDropdown((dropdown) => {
						for (const [value, name] of Object.entries(SYNC_INTERVAL_NAMES)) {
							dropdown.addOption(value, name);
						}
						dropdown.setValue(String(this.plugin.settings.syncIntervalMinutes));
						dropdown.onChange(async (value) => {
							this.plugin.settings.syncIntervalMinutes = parseInt(value) as SyncIntervalMinutes;
							await this.plugin.saveSettings();
							this.plugin.onSettingsChanged();
						});
					});
			}

			// Sync on startup
			new Setting(containerEl)
				.setName('Sync on startup')
				.setDesc('Sync when Obsidian starts')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.syncOnStartup);
					toggle.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					});
				});
		}
	}

	/**
	 * Render the Backup settings section.
	 *
	 * Always shows the "Enable backups" master toggle. When enabled, renders backup
	 * prefix, interval, retention policy sub-section (mode + days/copies depending on
	 * mode), and a "Backup now" button. Toggling backup or changing the interval calls
	 * `this.plugin.onSettingsChanged()` to restart the backup scheduler.
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderBackupSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Backup').setHeading();

		new Setting(containerEl)
			.setName('Enable backups')
			.setDesc('Create scheduled backup snapshots of your vault')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.backupEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.backupEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.display();
				});
			});

		if (this.plugin.settings.backupEnabled) {
			// Backup Prefix
			new Setting(containerEl)
				.setName('Backup prefix')
				.setDesc('S3 path prefix for backups (e.g., "backups" → s3://bucket/backups/)')
				.addText((text) => {
					text.setPlaceholder('backups');
					text.setValue(this.plugin.settings.backupPrefix);
					text.onChange(async (value) => {
						this.plugin.settings.backupPrefix = normalizePrefix(value) || 'backups';
						await this.plugin.saveSettings();
					});
				});

			// Backup interval
			new Setting(containerEl)
				.setName('Backup interval')
				.setDesc('How often to create backup snapshots')
				.addDropdown((dropdown) => {
					for (const [value, name] of Object.entries(BACKUP_INTERVAL_NAMES)) {
						dropdown.addOption(value, name);
					}
					dropdown.setValue(this.plugin.settings.backupInterval);
					dropdown.onChange(async (value) => {
						this.plugin.settings.backupInterval = value as BackupInterval;
						await this.plugin.saveSettings();
						this.plugin.onSettingsChanged();
					});
				});

			// Retention settings header
			new Setting(containerEl).setName('Retention policy').setHeading();

			new Setting(containerEl)
				.setName('Enable retention')
				.setDesc('Automatically delete old backups')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.retentionEnabled);
					toggle.onChange(async (value) => {
						this.plugin.settings.retentionEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					});
				});

			if (this.plugin.settings.retentionEnabled) {
				// Retention mode
				new Setting(containerEl)
					.setName('Retention mode')
					.setDesc('How to determine which backups to keep')
					.addDropdown((dropdown) => {
						dropdown.addOption('days', 'By days');
						dropdown.addOption('copies', 'By copies');
						dropdown.setValue(this.plugin.settings.retentionMode);
						dropdown.onChange(async (value) => {
							this.plugin.settings.retentionMode = value as RetentionMode;
							await this.plugin.saveSettings();
							this.display();
						});
					});

				if (this.plugin.settings.retentionMode === 'days') {
					new Setting(containerEl)
						.setName('Retention days')
						.setDesc('Delete backups older than this many days (1-360)')
						.addText((text) => {
							text.setPlaceholder('30');
							text.setValue(String(this.plugin.settings.retentionDays));
							text.onChange(async (value) => {
								const days = parseInt(value) || 30;
								this.plugin.settings.retentionDays = Math.max(1, Math.min(360, days));
								await this.plugin.saveSettings();
							});
						});
				} else {
					new Setting(containerEl)
						.setName('Retention copies')
						.setDesc('Keep only the latest N backups (1-1000)')
						.addText((text) => {
							text.setPlaceholder('30');
							text.setValue(String(this.plugin.settings.retentionCopies));
							text.onChange(async (value) => {
								const copies = parseInt(value) || 30;
								this.plugin.settings.retentionCopies = Math.max(1, Math.min(1000, copies));
								await this.plugin.saveSettings();
							});
						});
				}
			}

			// Backup Now button
			new Setting(containerEl)
				.setName('Manual backup')
				.setDesc('Create a backup snapshot now')
				.addButton((button) => {
					button.setButtonText('Backup now');
					button.onClick(async () => {
						await this.plugin.triggerManualBackup();
					});
				});
		}
	}

	/**
	 * Render the Advanced settings section.
	 *
	 * Renders debug logging toggle, exclude patterns textarea, and a "Reset to defaults"
	 * button. Exclude patterns are comma-separated glob strings (e.g., `workspace*`).
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Advanced').setHeading();

		// Debug logging
		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable verbose logging for troubleshooting')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.debugLogging);
				toggle.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				});
			});

		// Exclude patterns
		new Setting(containerEl)
			.setName('Exclude patterns')
			.setDesc('Files/folders to exclude from sync (comma-separated globs)')
			.addTextArea((text) => {
				text.setPlaceholder('workspace*, .trash/*');
				text.setValue(this.plugin.settings.excludePatterns.join(', '));
				text.onChange(async (value) => {
					this.plugin.settings.excludePatterns = value
						.split(',')
						.map((p) => p.trim())
						.filter((p) => p.length > 0);
					await this.plugin.saveSettings();
				});
			});

		// Reset to defaults
		new Setting(containerEl)
			.setName('Reset to defaults')
			.setDesc('Reset all settings to their default values')
			.addButton((button) => {
				button.setButtonText('Reset');
				button.setWarning();
				button.onClick(async () => {
					// Will implement reset logic
					new Notice('Reset functionality coming soon');
				});
			});
	}
}

/**
 * Confirmation modal shown when the user requests to disable encryption.
 *
 * Warns that all vault files will be re-uploaded to S3 as plaintext and that
 * the operation cannot be interrupted once started. Resolves a Promise with
 * `true` when the user clicks "Disable encryption", or `false` on cancel /
 * close.
 */
class DisableEncryptionModal extends Modal {
	private resolve: (value: boolean) => void;

	constructor(app: App, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Disable encryption?' });

		contentEl.createEl('p', {
			text:
				'This will re-upload every file in your vault to S3 as plaintext. ' +
				'The operation may take several minutes depending on vault size.',
		});

		contentEl.createEl('p', {
			text:
				'Other devices syncing this vault will detect the change and ' +
				'switch to plaintext mode automatically on their next sync.',
			cls: 'mod-warning',
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer
			.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => {
				this.resolve(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl('button', {
			text: 'Disable encryption',
			cls: 'mod-warning',
		});
		confirmBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		// If the user closed the modal via Escape or clicking outside,
		// resolve as cancelled so the caller isn't left hanging.
		this.resolve(false);
	}
}
