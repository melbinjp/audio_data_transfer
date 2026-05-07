export const APP_VERSION = {
    code: 2026050704,
    name: 'Mango Modem',
    semver: '1.1.1',
    protocol: 3,
} as const;

export function formatAppVersion(): string {
    return `${APP_VERSION.name} ${APP_VERSION.semver} (${APP_VERSION.code}, protocol ${APP_VERSION.protocol})`;
}
