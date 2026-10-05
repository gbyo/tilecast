package org.tilecast.player.content

data class WebsitePlaybackStatus(val assetId:String?=null,val state:String="idle",val loadStartedAt:String?=null,val loadCompletedAt:String?=null,val failureCategory:String?=null,val blockedNavigationCount:Int=0,val currentHost:String?=null,val fallbackShown:Boolean=false,val rendererRecoveryCount:Int=0)
