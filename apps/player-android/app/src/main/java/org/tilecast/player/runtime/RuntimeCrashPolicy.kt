package org.tilecast.player.runtime

/** Renderer-generation tracking for the trusted runtime WebView.
 *
 * A dead renderer instance must never report evidence again: every report is
 * tagged with the generation that produced it, and stale generations are
 * dropped. Recovery always constructs a fresh WebView and replays current
 * state only after the new runtime signals ready.
 */
class RuntimeCrashPolicy(
    /**
     * Source of renderer generations. Production passes the process-wide
     * allocator so no two renderers in one process ever share an identity;
     * the default is a private counter for isolated host tests.
     */
    private val allocate: () -> Long = localGenerations(),
) {
    private var generation = allocate()
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
        generation = allocate()
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

    private companion object {
        fun localGenerations(): () -> Long {
            var last = 0L
            return { ++last }
        }
    }
}
