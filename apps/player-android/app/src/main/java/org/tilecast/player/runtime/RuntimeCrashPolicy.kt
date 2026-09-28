package org.tilecast.player.runtime

/** Renderer-generation tracking for the trusted runtime WebView.
 *
 * A dead renderer instance must never report evidence again: every report is
 * tagged with the generation that produced it, and stale generations are
 * dropped. Recovery always constructs a fresh WebView and replays current
 * state only after the new runtime signals ready.
 */
class RuntimeCrashPolicy {
    private var generation = 1L
    private var deadGenerations: MutableSet<Long> = HashSet()
    private var readyGenerations: MutableSet<Long> = HashSet()

    fun currentGeneration(): Long = generation

    /** Marks the current instance dead after `onRenderProcessGone`. Never reuse it. */
    fun onRendererGone(): Long {
        deadGenerations.add(generation)
        readyGenerations.remove(generation)
        return generation
    }

    /** Starts a fresh instance. Returns its generation. */
    fun onRecreated(): Long {
        generation += 1
        return generation
    }

    fun onRuntimeReady(reportGeneration: Long) {
        if (reportGeneration !in deadGenerations) {
            readyGenerations.add(reportGeneration)
        }
    }

    /** True when a report from `reportGeneration` may mutate current state. */
    fun acceptsReport(reportGeneration: Long): Boolean =
        reportGeneration == generation && reportGeneration !in deadGenerations

    fun isReady(): Boolean = generation in readyGenerations
}
