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

import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type S3SyncBackupPlugin from './main';
import {
	S3SyncBackupSettings,
	S3ProviderType,
	S3_PROVIDER_NAMES,
	SyncIntervalMinutes,
	BackupInterval,
	BACKUP_INTERVAL_NAMES,
	RetentionMode,
} from './types';
import { S3Provider } from './storage/S3Provider';

/**
 * Sync interval display names for dropdown
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
 * S3SyncBackupSettingTab - Plugin settings UI
 */
export class S3SyncBackupSettingTab extends PluginSettingTab {
	plugin: S3SyncBackupPlugin;
	private testConnectionButton: HTMLButtonElement | null = null;

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
	 * Render Connection Settings Section
	 */
	private renderConnectionSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Connection' });

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
				text.setPlaceholder('my-obsidian-bucket');
				text.setValue(this.plugin.settings.bucket);
				text.onChange(async (value) => {
					this.plugin.settings.bucket = value;
					await this.plugin.saveSettings();
				});
			});

		// Access Key ID
		new Setting(containerEl)
			.setName('Access Key ID')
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
			.setName('Secret Access Key')
			.setDesc('Your S3 secret access key')
			.addText((text) => {
				text.setPlaceholder('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
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
				.setName('Force Path Style')
				.setDesc('Use path-style URLs (required for MinIO and some S3-compatible services)')
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
			.setName('Test Connection')
			.setDesc('Verify your S3 credentials and bucket access');

		testConnectionSetting.addButton((button) => {
			this.testConnectionButton = button.buttonEl;
			button.setButtonText('Test Connection');
			button.onClick(async () => {
				await this.testConnection(button.buttonEl);
			});
		});
	}

	/**
	 * Get endpoint description based on provider
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
	 * Get endpoint placeholder based on provider
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
	 * Test S3 connection
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
			buttonEl.textContent = '✓ Connected';

			// Reset button text after delay
			setTimeout(() => {
				buttonEl.textContent = originalText;
				buttonEl.disabled = false;
			}, 2000);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`✗ ${errorMessage}`);
			buttonEl.textContent = '✗ Failed';
			buttonEl.disabled = false;

			// Reset button text after delay
			setTimeout(() => {
				buttonEl.textContent = originalText;
			}, 2000);
		}
	}

	/**
	 * Render Encryption Settings Section
	 */
	private renderEncryptionSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Encryption' });

		new Setting(containerEl)
			.setName('Enable End-to-End Encryption')
			.setDesc('Encrypt all files before uploading to S3')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.encryptionEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.encryptionEnabled = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide passphrase fields
				});
			});

		if (this.plugin.settings.encryptionEnabled) {
			// Note about encryption
			const noteEl = containerEl.createEl('div', {
				cls: 's3-sync-backup-warning',
			});
			noteEl.createEl('p', {
				text: '⚠️ This passphrase encrypts both synced files AND backups. If lost, your data CANNOT be recovered.',
			});

			// Passphrase field will be implemented when encryption is built
			new Setting(containerEl)
				.setName('Passphrase')
				.setDesc('Enter a strong passphrase (minimum 12 characters)')
				.addText((text) => {
					text.setPlaceholder('Enter passphrase...');
					text.inputEl.type = 'password';
					// Note: Passphrase is NOT saved to settings
					// It will be handled by the encryption module
				});
		}
	}

	/**
	 * Render Sync Settings Section
	 */
	private renderSyncSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Sync' });

		new Setting(containerEl)
			.setName('Enable Sync')
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
				.setName('Sync Prefix')
				.setDesc('S3 path prefix for synced files (e.g., "vault" → s3://bucket/vault/)')
				.addText((text) => {
					text.setPlaceholder('vault');
					text.setValue(this.plugin.settings.syncPrefix);
					text.onChange(async (value) => {
						this.plugin.settings.syncPrefix = value || 'vault';
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
					.setName('Sync Interval')
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
				.setName('Sync on Startup')
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
	 * Render Backup Settings Section
	 */
	private renderBackupSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Backup' });

		new Setting(containerEl)
			.setName('Enable Backups')
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
				.setName('Backup Prefix')
				.setDesc('S3 path prefix for backups (e.g., "backups" → s3://bucket/backups/)')
				.addText((text) => {
					text.setPlaceholder('backups');
					text.setValue(this.plugin.settings.backupPrefix);
					text.onChange(async (value) => {
						this.plugin.settings.backupPrefix = value || 'backups';
						await this.plugin.saveSettings();
					});
				});

			// Backup interval
			new Setting(containerEl)
				.setName('Backup Interval')
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
			containerEl.createEl('h4', { text: 'Retention Policy' });

			new Setting(containerEl)
				.setName('Enable Retention')
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
					.setName('Retention Mode')
					.setDesc('How to determine which backups to keep')
					.addDropdown((dropdown) => {
						dropdown.addOption('days', 'By Days');
						dropdown.addOption('copies', 'By Copies');
						dropdown.setValue(this.plugin.settings.retentionMode);
						dropdown.onChange(async (value) => {
							this.plugin.settings.retentionMode = value as RetentionMode;
							await this.plugin.saveSettings();
							this.display();
						});
					});

				if (this.plugin.settings.retentionMode === 'days') {
					new Setting(containerEl)
						.setName('Retention Days')
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
						.setName('Retention Copies')
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
				.setName('Manual Backup')
				.setDesc('Create a backup snapshot now')
				.addButton((button) => {
					button.setButtonText('Backup Now');
					button.onClick(async () => {
						// Will be connected to backup engine
						new Notice('Backup triggered (not yet implemented)');
					});
				});
		}
	}

	/**
	 * Render Advanced Settings Section
	 */
	private renderAdvancedSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Advanced' });

		// Debug logging
		new Setting(containerEl)
			.setName('Debug Logging')
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
			.setName('Exclude Patterns')
			.setDesc('Files/folders to exclude from sync (comma-separated globs)')
			.addTextArea((text) => {
				text.setPlaceholder('.obsidian/workspace*, .trash/*');
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
			.setName('Reset to Defaults')
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
