export const APP_VERSION = {
    code: 2026062501,
    name: 'Mango Modem',
    semver: '1.3.1',
    protocol: 4,
} as const;

export function formatAppVersion(): string {
    return `${APP_VERSION.name} ${APP_VERSION.semver} (${APP_VERSION.code}, protocol ${APP_VERSION.protocol})`;
}
