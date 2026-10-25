/** Adds operation and region details while preserving the original AWS error as cause. */
function withOperationContext(error, operation, region) {
    const source = error ?? {};
    const contextual = new Error(source.message ?? String(error), { cause: error });
    contextual.name = operation === 'ResolveRegion' && /region is missing/i.test(source.message ?? '')
        ? 'RegionNotConfigured'
        : source.name ?? contextual.name;
    contextual.operation = operation;
    contextual.region = region;
    contextual.$metadata = source.$metadata;
    return contextual;
}

module.exports = { withOperationContext };