// Lockdown mode: the enforcement seam every augmentation path must consult.
//
// When a thread is in lockdown, Genze may not enrich the reply with anything
// the user didn't write themselves: no web search, no research tools, no
// agent actions, no memory writes. Files attached to a message and project
// instructions keep working in lockdown — they are the user's own content on
// the direct chat path, not an augmentation.
//
// Add new flags here as new augmentation channels land; every augmentation
// call site must consult chatAugmentations() before firing.
export function chatAugmentations(thread) {
    if (thread.lockdown) {
        return { web: false, agent: false, memory: false };
    }
    return { web: true, agent: true, memory: true };
}
//# sourceMappingURL=lockdown.js.map