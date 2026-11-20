export function defineAutomation(spec) {
    return {
        name: spec.name,
        matches: spec.matches,
        run: (event, ctx) => spec.run(event, ctx),
    };
}
export const withDryRun = (automation) => ({ ...automation, dryRun: true });
