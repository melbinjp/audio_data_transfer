export const APP_VERSION = {
    code: 2026050705,
    name: 'Mango Modem',
    semver: '1.2.0',
    protocol: 3,
} as const;

export function formatAppVersion(): string {
    return `${APP_VERSION.name} ${APP_VERSION.semver} (${APP_VERSION.code}, protocol ${APP_VERSION.protocol})`;
}
