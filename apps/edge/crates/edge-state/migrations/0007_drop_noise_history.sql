-- M7 Plugin API cleanup: the Noise Meter is removed, so its local history
-- goes with it. The daemon no longer writes or reads this table; dropping it
-- reclaims device storage and leaves no orphaned schema behind. Fresh
-- installs never create it. The presentation_network_state table from
-- 0005_hardware.sql stays: the Presentation Network helper still needs it.
DROP TABLE IF EXISTS noise_history;
