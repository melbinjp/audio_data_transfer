export const APP_VERSION = {
    code: 2026050703,
    name: 'Mango Modem',
    semver: '1.1.0',
    protocol: 3,
} as const;

export function formatAppVersion(): string {
    return `${APP_VERSION.name} ${APP_VERSION.semver} (${APP_VERSION.code}, protocol ${APP_VERSION.protocol})`;
}
