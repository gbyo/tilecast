package org.tilecast.player.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "player_configuration")
data class PlayerConfiguration(
    @androidx.room.PrimaryKey val id: Int = 1,
    val playerInstallationId: String,
    val serverUrl: String? = null,
    val serverInstallationId: String? = null,
    val organizationName: String? = null,
    val screenId: String? = null,
    val screenName: String? = null,
    val pairingSessionId: String? = null,
    val pairingPollSecret: String? = null,
    val pairingCode: String? = null,
    val pairingExpiresAt: String? = null,
    val pairingPollingIntervalSeconds: Int? = null,
)

@Dao
interface PlayerConfigurationDao {
    @Query("SELECT * FROM player_configuration WHERE id=1") suspend fun get(): PlayerConfiguration?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(configuration: PlayerConfiguration)
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertIfAbsent(configuration: PlayerConfiguration): Long
    @Transaction
    suspend fun getOrCreate(candidate: PlayerConfiguration): PlayerConfiguration {
        get()?.let { return it }
        insertIfAbsent(candidate)
        return get() ?: candidate
    }
    @Query("UPDATE player_configuration SET screenId=NULL,screenName=NULL WHERE id=1") suspend fun clearPairing()
    @Query("DELETE FROM player_configuration") suspend fun reset()
}

@Entity(tableName = "stored_manifests")
data class StoredManifest(
    @androidx.room.PrimaryKey val manifestVersion: Long,
    val schemaVersion: Int,
    val rawJson: String,
    val etag: String? = null,
    val state: String,
    val receivedAt: Long,
    val readyAt: Long? = null,
    val activatedAt: Long? = null,
    val failureReason: String? = null,
    val installationId: String? = null,
    val screenId: String? = null,
    val normalizedServerUrl: String? = null,
)

@Entity(tableName = "cached_assets")
data class CachedAsset(
    @androidx.room.PrimaryKey val variantId: String,
    val assetId: String,
    val sha256: String,
    val expectedFileSize: Long,
    val localPath: String,
    val downloadStatus: String,
    val downloadedBytes: Long = 0,
    val lastVerifiedAt: Long? = null,
    val lastUsedAt: Long? = null,
    val requiredByActiveManifest: Boolean = false,
    val requiredByPendingManifest: Boolean = false,
    val failureReason: String? = null,
    val installationId: String? = null,
    val screenId: String? = null,
    val normalizedServerUrl: String? = null,
)

@Entity(tableName="player_configs")
data class StoredPlayerConfig(@androidx.room.PrimaryKey val configRevision:Long,val schemaVersion:Int,val rawJson:String,val etag:String?,val state:String,val receivedAt:Long,val activatedAt:Long?=null,val error:String?=null,val installationId:String?=null,val screenId:String?=null,val normalizedServerUrl:String?=null)
@Dao interface PlayerConfigDao{
    @Query("SELECT * FROM player_configs WHERE state='active' ORDER BY configRevision DESC LIMIT 1") suspend fun active():StoredPlayerConfig?
    @Query("SELECT * FROM player_configs WHERE state='previous' ORDER BY configRevision DESC LIMIT 1") suspend fun previous():StoredPlayerConfig?
    @Insert(onConflict=OnConflictStrategy.REPLACE) suspend fun save(config:StoredPlayerConfig)
    @Query("DELETE FROM player_configs") suspend fun clear()
    @Query("UPDATE player_configs SET state='previous' WHERE state='active'") suspend fun demoteActive()
    @Query("UPDATE player_configs SET state='active',activatedAt=:now WHERE configRevision=:revision") suspend fun activateRevision(revision:Long,now:Long)
    @Query("DELETE FROM player_configs WHERE state='previous' AND configRevision NOT IN(SELECT configRevision FROM player_configs WHERE state='previous' ORDER BY activatedAt DESC LIMIT 1)") suspend fun prune()
    @Transaction suspend fun activate(revision:Long,now:Long){demoteActive();activateRevision(revision,now);prune()}
}

@Dao interface ManifestDao {
    @Query("SELECT * FROM stored_manifests WHERE state='active' ORDER BY activatedAt DESC LIMIT 1") suspend fun active(): StoredManifest?
    @Query("SELECT * FROM stored_manifests WHERE state='ready' ORDER BY manifestVersion DESC LIMIT 1") suspend fun ready(): StoredManifest?
    @Query("SELECT * FROM stored_manifests WHERE manifestVersion=:version") suspend fun byVersion(version: Long): StoredManifest?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(manifest: StoredManifest)
    @Query("UPDATE stored_manifests SET state='superseded' WHERE state='active'") suspend fun supersedeActive()
    @Query("UPDATE stored_manifests SET state='active',activatedAt=:now WHERE manifestVersion=:version") suspend fun setActive(version: Long, now: Long)
	@Query("DELETE FROM stored_manifests WHERE state='superseded' AND manifestVersion NOT IN (SELECT manifestVersion FROM stored_manifests WHERE state='superseded' ORDER BY activatedAt DESC LIMIT 1)") suspend fun pruneSuperseded()
    @Query("UPDATE stored_manifests SET state=:state,readyAt=:readyAt,failureReason=:failure WHERE manifestVersion=:version") suspend fun setState(version: Long, state: String, readyAt: Long?, failure: String?)
    @Query("DELETE FROM stored_manifests") suspend fun clear()
    @Transaction suspend fun activate(version: Long, now: Long) { supersedeActive(); setActive(version, now); pruneSuperseded() }
}

@Dao interface CachedAssetDao {
    @Query("SELECT * FROM cached_assets WHERE variantId=:variantId") suspend fun get(variantId: String): CachedAsset?
    @Query("SELECT * FROM cached_assets") suspend fun all(): List<CachedAsset>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(asset: CachedAsset)
	@Query("DELETE FROM cached_assets") suspend fun clear()
	@Query("UPDATE cached_assets SET requiredByPendingManifest=0") suspend fun clearPendingRequirements()
    @Query("UPDATE cached_assets SET requiredByPendingManifest=1 WHERE variantId IN (:ids)") suspend fun requirePending(ids: List<String>)
    @Query("UPDATE cached_assets SET requiredByActiveManifest=requiredByPendingManifest,requiredByPendingManifest=0") suspend fun promoteRequirements()
    @Query("DELETE FROM cached_assets WHERE variantId=:variantId") suspend fun delete(variantId: String)
}

@Database(entities = [PlayerConfiguration::class, StoredManifest::class, CachedAsset::class,StoredPlayerConfig::class], version = 5, exportSchema = true)
abstract class PlayerDatabase : RoomDatabase() {
    abstract fun configuration(): PlayerConfigurationDao
    abstract fun manifests(): ManifestDao
    abstract fun cachedAssets(): CachedAssetDao
    abstract fun playerConfigs():PlayerConfigDao
    companion object {
        @Volatile private var instance: PlayerDatabase? = null
        val MIGRATION_1_2 = object : Migration(1, 2) { override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS stored_manifests (manifestVersion INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, rawJson TEXT NOT NULL, etag TEXT, state TEXT NOT NULL, receivedAt INTEGER NOT NULL, readyAt INTEGER, activatedAt INTEGER, failureReason TEXT, PRIMARY KEY(manifestVersion))")
            db.execSQL("CREATE TABLE IF NOT EXISTS cached_assets (variantId TEXT NOT NULL, assetId TEXT NOT NULL, sha256 TEXT NOT NULL, expectedFileSize INTEGER NOT NULL, localPath TEXT NOT NULL, downloadStatus TEXT NOT NULL, downloadedBytes INTEGER NOT NULL, lastVerifiedAt INTEGER, lastUsedAt INTEGER, requiredByActiveManifest INTEGER NOT NULL, requiredByPendingManifest INTEGER NOT NULL, failureReason TEXT, PRIMARY KEY(variantId))")
        } }
        val MIGRATION_2_3=object:Migration(2,3){override fun migrate(db:SupportSQLiteDatabase){db.execSQL("CREATE TABLE IF NOT EXISTS player_configs (configRevision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, rawJson TEXT NOT NULL, etag TEXT, state TEXT NOT NULL, receivedAt INTEGER NOT NULL, activatedAt INTEGER, error TEXT, PRIMARY KEY(configRevision))")}}
        val MIGRATION_3_4=object:Migration(3,4){override fun migrate(db:SupportSQLiteDatabase){
            db.execSQL("ALTER TABLE player_configuration ADD COLUMN pairingSessionId TEXT")
            db.execSQL("ALTER TABLE player_configuration ADD COLUMN pairingPollSecret TEXT")
            db.execSQL("ALTER TABLE player_configuration ADD COLUMN pairingCode TEXT")
            db.execSQL("ALTER TABLE player_configuration ADD COLUMN pairingExpiresAt TEXT")
            db.execSQL("ALTER TABLE player_configuration ADD COLUMN pairingPollingIntervalSeconds INTEGER")
        }}
        val MIGRATION_4_5=object:Migration(4,5){override fun migrate(db:SupportSQLiteDatabase){
            db.execSQL("ALTER TABLE stored_manifests ADD COLUMN installationId TEXT")
            db.execSQL("ALTER TABLE stored_manifests ADD COLUMN screenId TEXT")
            db.execSQL("ALTER TABLE stored_manifests ADD COLUMN normalizedServerUrl TEXT")
            db.execSQL("ALTER TABLE cached_assets ADD COLUMN installationId TEXT")
            db.execSQL("ALTER TABLE cached_assets ADD COLUMN screenId TEXT")
            db.execSQL("ALTER TABLE cached_assets ADD COLUMN normalizedServerUrl TEXT")
            db.execSQL("ALTER TABLE player_configs ADD COLUMN installationId TEXT")
            db.execSQL("ALTER TABLE player_configs ADD COLUMN screenId TEXT")
            db.execSQL("ALTER TABLE player_configs ADD COLUMN normalizedServerUrl TEXT")
        }}
        fun get(context: Context): PlayerDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, PlayerDatabase::class.java, "tilecast-player.db").addMigrations(MIGRATION_1_2,MIGRATION_2_3,MIGRATION_3_4,MIGRATION_4_5).build().also { instance = it }
        }
    }
}
