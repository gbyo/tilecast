package org.tilecast.player.content

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.delay
import org.tilecast.player.network.CardsWidgetConfig
import org.tilecast.player.network.CountdownWidgetConfig
import org.tilecast.player.network.DisplayWidgetConfig
import org.tilecast.player.network.FieldFormat
import org.tilecast.player.network.MetricWidgetConfig
import org.tilecast.player.network.TickerWidgetConfig
import org.tilecast.player.network.TypedRecord
import org.tilecast.player.network.TypedRecordData
import org.tilecast.player.network.WeatherWidgetConfig

@Composable
internal fun ExpandedCountdownWidget(config: CountdownWidgetConfig) {
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(config.showSeconds) {
        while (true) {
            now = serverNow()
            delay(if (config.showSeconds) 1_000 else 15_000)
        }
    }
    val units = listOf(config.showDays, config.showHours, config.showMinutes, config.showSeconds).joinToString("") { if (it) "1" else "0" }
    val text = formatCountdown(config.target, config.timezone, config.mode, config.recurrence, config.completionAction, config.completionText, units, now) ?: return
    // contentPadding is a percentage of each edge, not dp, and the typography
    // follows the Widget's bounds so an author scale of 25–500 percent stays
    // inside the content area instead of clipping.
    BoxWithConstraints(Modifier.fillMaxSize().background(parseExpandedColor(config.backgroundColor)), contentAlignment = Alignment.Center) {
        val inset = widgetPaddingFraction(config.contentPadding)
        val areaWidth = maxWidth.value * (1f - 2f * inset)
        val areaHeight = maxHeight.value * (1f - 2f * inset)
        val fontScale = LocalDensity.current.fontScale
        val stacked = config.layout == "stacked" && config.label.isNotBlank()
        val metricHeight = if (stacked) areaHeight * 0.7f else areaHeight
        val estimatedMetricSize = scaledFittedFontSizeSp(
            textLength = text.length,
            widthDp = if (config.layout == "horizontal") areaWidth * 0.65f else areaWidth,
            heightDp = metricHeight,
            fontScale = fontScale,
            textScale = config.textScale,
        )
        // Fit-to-bounds is the final guard: the estimate above may overshoot
        // for an enlarged scale, so shrink on measured overflow rather than clip.
        var metricSize by remember(text, maxWidth, maxHeight, fontScale, config.textScale, config.contentPadding, config.layout) {
            mutableStateOf(estimatedMetricSize)
        }
        val labelSize = scaledFittedFontSizeSp(
            textLength = config.label.length.coerceAtLeast(1),
            widthDp = if (config.layout == "horizontal") areaWidth * 0.35f else areaWidth,
            heightDp = if (stacked) areaHeight * 0.3f else areaHeight * 0.25f,
            fontScale = fontScale,
            textScale = config.textScale,
        ).coerceAtMost(metricSize * 0.45f)
        val label: @Composable () -> Unit = {
            if (config.label.isNotBlank()) Text(config.label, color = parseExpandedColor(config.foregroundColor).copy(alpha=.75f), fontSize = labelSize.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val metric: @Composable () -> Unit = {
            Text(
                text,
                color = parseExpandedColor(config.foregroundColor),
                fontSize = metricSize.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Clip,
                onTextLayout = { result ->
                    if ((result.didOverflowWidth || result.didOverflowHeight) && metricSize > 8f) {
                        metricSize = (metricSize * 0.9f).coerceAtLeast(8f)
                    }
                },
            )
        }
        Box(Modifier.fillMaxSize().padding(horizontal = (maxWidth.value * inset).dp, vertical = (maxHeight.value * inset).dp), contentAlignment = Alignment.Center) {
            when (config.layout) {
                "countdown_only" -> metric()
                "horizontal" -> Row(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) { label(); metric() }
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) { label(); metric() }
            }
        }
    }
}

@Composable
internal fun ExpandedTickerWidget(config: TickerWidgetConfig, data: TypedRecordData) {
    val records = selectedTypedRecords(data, LocalTilecastServerNow.current(), LocalTilecastRegionalFormatting.current.firstDay())
    val fields = config.fields.ifEmpty { listOf(config.field) }.take(3)
    val text = records.mapNotNull { record ->
        fields.mapNotNull { record.values[it]?.takeIf(String::isNotBlank) }.joinToString(config.fieldSeparator).takeIf(String::isNotBlank)
    }.joinToString(config.separator).ifBlank { config.emptyState }
    BoxWithConstraints(Modifier.fillMaxSize().background(parseExpandedColor(config.backgroundColor)), contentAlignment = Alignment.CenterStart) {
        val distance = maxWidth.value + text.length * 22f
        val duration = when(config.speed){"slow"->30000;"fast"->10000;else->18000}
        val transition=rememberInfiniteTransition(label="ticker")
        val offset by transition.animateFloat(
            initialValue=if(config.direction=="right")-text.length*22f else maxWidth.value,
            targetValue=if(config.direction=="right")maxWidth.value else -text.length*22f,
            animationSpec=infiniteRepeatable(tween(duration,easing=LinearEasing),RepeatMode.Restart),
            label="ticker-offset",
        )
        Text(text,modifier=Modifier.graphicsLayer{translationX=offset}.padding(horizontal=(maxWidth.value*widgetPaddingFraction(config.contentPadding)).dp),color=parseExpandedColor(config.foregroundColor),fontSize=(34f*widgetAuthorScale(config.textScale)).sp,maxLines=1,softWrap=false)
    }
}

@Composable
internal fun ExpandedDisplayWidget(provider:String,name:String,config:DisplayWidgetConfig,data:TypedRecordData) {
    val records=selectedTypedRecords(data,LocalTilecastServerNow.current(),LocalTilecastRegionalFormatting.current.firstDay()).take(config.maximumItems)
    when(provider){
        "menu"->ExpandedMenu(name,config,records)
        "table"->ExpandedTable(config,records,data.fields.mapNotNull{field->field.currency.takeIf(String::isNotBlank)?.let{field.key to it}}.toMap())
        "agenda"->ExpandedAgenda(config,records)
        else->ExpandedList(config,records)
    }
}

@Composable private fun ExpandedList(config:DisplayWidgetConfig,records:List<TypedRecord>){
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(records.isEmpty()){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize(),verticalArrangement=Arrangement.spacedBy(if(config.rowSpacing=="compact")4.dp else 12.dp)){
            records.forEachIndexed{index,record->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(14.dp),verticalAlignment=Alignment.CenterVertically){
                    field(record,config.leadingField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.7f),fontSize=18.sp)}
                    Column(Modifier.weight(1f)){
                        Text(field(record,config.primaryField.ifBlank{config.fields.firstOrNull().orEmpty()}),color=parseExpandedColor(config.foregroundColor),fontSize=(26f*widgetAuthorScale(config.textScale)).sp,fontWeight=FontWeight.Medium,maxLines=1,overflow=TextOverflow.Ellipsis)
                        field(record,config.secondaryField.ifBlank{config.fields.getOrNull(1).orEmpty()}).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f),fontSize=(18f*widgetAuthorScale(config.textScale)).sp,maxLines=1,overflow=TextOverflow.Ellipsis)}
                    }
                    field(record,config.trailingField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor),fontSize=18.sp)}
                }
                if(config.showDividers&&index<records.lastIndex)HorizontalDivider(color=parseExpandedColor(config.foregroundColor).copy(alpha=.18f))
            }
        }
    }
}

@Composable private fun ExpandedMenu(name:String,config:DisplayWidgetConfig,records:List<TypedRecord>){
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(records.isEmpty()){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize(),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center){
            Text(name,color=parseExpandedColor(config.foregroundColor),fontSize=24.sp,fontWeight=FontWeight.Bold)
            if(config.mode=="single_record"){
                val record=records.first()
                config.fields.forEach{key->field(record,key).takeIf(String::isNotBlank)?.let{value->Text(value,color=parseExpandedColor(config.foregroundColor),fontSize=(38f*widgetAuthorScale(config.textScale)).sp,fontWeight=FontWeight.Medium,textAlign=TextAlign.Center,maxLines=2,overflow=TextOverflow.Ellipsis)}}
            }else records.forEach{record->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
                    Text(field(record,config.labelField.ifBlank{config.fields.firstOrNull().orEmpty()}),color=parseExpandedColor(config.foregroundColor),fontSize=24.sp)
                    Text(field(record,config.valueField.ifBlank{config.fields.getOrNull(1).orEmpty()}),color=parseExpandedColor(config.foregroundColor),fontSize=24.sp,fontWeight=FontWeight.Bold)
                }
            }
        }
    }
}

@Composable private fun ExpandedTable(config:DisplayWidgetConfig,records:List<TypedRecord>,fieldCurrencies:Map<String,String>){
    val columns=config.columns.ifEmpty{config.fields.map{FieldFormat(it,it)}}
    val regional=LocalTilecastRegionalFormatting.current
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(records.isEmpty()){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize()){
            if(config.showHeader)Row(Modifier.fillMaxWidth()){columns.forEach{column->Text(column.label.ifBlank{column.field},Modifier.weight((column.width.takeIf{it>0}?:1).toFloat()),color=parseExpandedColor(config.foregroundColor).copy(alpha=.7f),fontWeight=FontWeight.Bold,fontSize=17.sp)}}
            records.forEachIndexed{index,record->
                Row(Modifier.fillMaxWidth().background(if(config.alternatingRows&&index%2==1)parseExpandedColor(config.foregroundColor).copy(alpha=.06f) else androidx.compose.ui.graphics.Color.Transparent).padding(vertical=8.dp)){
                    columns.forEach{column->Text(formatTyped(field(record,column.field),column,fieldCurrencies[column.field],regional),Modifier.weight((column.width.takeIf{it>0}?:1).toFloat()),color=parseExpandedColor(config.foregroundColor),fontSize=19.sp,maxLines=1,overflow=TextOverflow.Ellipsis,textAlign=align(column.alignment))}
                }
            }
        }
    }
}

@Composable private fun ExpandedAgenda(config:DisplayWidgetConfig,records:List<TypedRecord>){
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(records.isEmpty()){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize(),verticalArrangement=Arrangement.spacedBy(10.dp)){
            records.forEach{record->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(18.dp)){
                    Column(Modifier.weight(.25f)){Text(field(record,config.dateField.ifBlank{"date"}),color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f),fontSize=16.sp);Text(field(record,config.timeField.ifBlank{"startTime"}),color=parseExpandedColor(config.foregroundColor),fontSize=18.sp)}
                    Column(Modifier.weight(.75f)){Text(field(record,config.titleField.ifBlank{"title"}),color=parseExpandedColor(config.foregroundColor),fontSize=23.sp,fontWeight=FontWeight.Medium);field(record,config.locationField.ifBlank{"location"}).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f),fontSize=16.sp)}}
                }
            }
        }
    }
}

@Composable internal fun ExpandedMetricWidget(config:MetricWidgetConfig,data:TypedRecordData){
    val regional=LocalTilecastRegionalFormatting.current
    val record=selectedTypedRecords(data,LocalTilecastServerNow.current(),regional.firstDay()).firstOrNull()
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(record==null){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize(),horizontalAlignment=when(config.alignment){"left"->Alignment.Start;"right"->Alignment.End;else->Alignment.CenterHorizontally},verticalArrangement=Arrangement.Center){
            val label=field(record,config.labelField).ifBlank{config.label}
            if(label.isNotBlank())Text(label,color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f),fontSize=22.sp)
            val currency=data.fields.firstOrNull{it.key==config.valueField}?.currency
            Text(config.prefix+formatMetric(field(record,config.valueField),config.format,config.precision,currency,regional)+config.suffix,color=parseExpandedColor(config.foregroundColor),fontSize=(64f*widgetAuthorScale(config.textScale)).sp,fontWeight=FontWeight.Bold,maxLines=1,overflow=TextOverflow.Ellipsis)
            field(record,config.secondaryField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f),fontSize=18.sp)}
        }
    }
}

@Composable internal fun ExpandedCardsWidget(config:CardsWidgetConfig,data:TypedRecordData){
    val records=selectedTypedRecords(data,LocalTilecastServerNow.current(),LocalTilecastRegionalFormatting.current.firstDay()).take(config.maximumItems)
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(records.isEmpty()){EmptyExpanded(config.emptyState,config.foregroundColor);return@WidgetSurface}
        LazyVerticalGrid(columns=GridCells.Fixed(config.columns),horizontalArrangement=Arrangement.spacedBy(10.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
            items(records,key={it.id}){record->
                Column(Modifier.background(parseExpandedColor(config.foregroundColor).copy(alpha=.08f)).padding(if(config.density=="compact")10.dp else 18.dp)){
                    field(record,config.badgeField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.68f),fontSize=14.sp)}
                    Text(field(record,config.titleField),color=parseExpandedColor(config.foregroundColor),fontSize=23.sp,fontWeight=FontWeight.Bold,maxLines=2,overflow=TextOverflow.Ellipsis)
                    field(record,config.subtitleField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor).copy(alpha=.76f),fontSize=17.sp,maxLines=1,overflow=TextOverflow.Ellipsis)}
                    field(record,config.bodyField).takeIf(String::isNotBlank)?.let{Text(it,color=parseExpandedColor(config.foregroundColor),fontSize=16.sp,maxLines=3,overflow=TextOverflow.Ellipsis)}
                }
            }
        }
    }
}

@Composable internal fun ExpandedWeatherWidget(config:WeatherWidgetConfig,data:TypedRecordData){
    val current=data.records.firstOrNull{it.values["kind"]=="current"}
    val forecast=data.records.filter{it.values["kind"]=="forecast"}.take(config.forecastDays)
    WidgetSurface(config.backgroundColor,config.contentPadding){
        if(current==null){EmptyExpanded("Weather temporarily unavailable",config.foregroundColor);return@WidgetSurface}
        Column(Modifier.fillMaxSize(),verticalArrangement=Arrangement.SpaceBetween){
            Column{
                if(config.showLocation)Text(field(current,"location"),color=parseExpandedColor(config.foregroundColor),fontSize=25.sp,fontWeight=FontWeight.Bold)
                if(config.showCurrent)Text("${field(current,"temperature")}${field(current,"temperatureUnit")}  ${field(current,"condition")}",color=parseExpandedColor(config.foregroundColor),fontSize=(44f*widgetAuthorScale(config.textScale)).sp,fontWeight=FontWeight.Bold)
                Row(horizontalArrangement=Arrangement.spacedBy(20.dp)){
                    if(config.showHumidity)Text("Humidity ${field(current,"humidity")}%",color=parseExpandedColor(config.foregroundColor).copy(alpha=.75f))
                    if(config.showWind)Text("Wind ${field(current,"windSpeed")} ${field(current,"windUnit")}",color=parseExpandedColor(config.foregroundColor).copy(alpha=.75f))
                    if(config.showPrecipitation)Text("Precip ${field(current,"precipitation")} ${field(current,"precipitationUnit")}",color=parseExpandedColor(config.foregroundColor).copy(alpha=.75f))
                }
            }
            if(forecast.isNotEmpty())Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){forecast.forEach{day->Column(horizontalAlignment=Alignment.CenterHorizontally){Text(field(day,"date").takeLast(5),color=parseExpandedColor(config.foregroundColor).copy(alpha=.72f));Text(field(day,"condition"),color=parseExpandedColor(config.foregroundColor),maxLines=1,overflow=TextOverflow.Ellipsis);Text("${field(day,"high")}/${field(day,"low")}${field(day,"temperatureUnit")}",color=parseExpandedColor(config.foregroundColor),fontWeight=FontWeight.Bold)}}}
            Text(data.attribution,color=parseExpandedColor(config.foregroundColor).copy(alpha=.55f),fontSize=12.sp)
        }
    }
}

internal fun selectedTypedRecords(data:TypedRecordData,now:Instant,firstDayOfWeek:java.time.DayOfWeek=java.time.DayOfWeek.MONDAY):List<TypedRecord>{
    val selection=data.dateSelection?:return data.records
    if(!selection.enabled||data.dateField.isBlank())return data.records
    val zone=runCatching{ZoneId.of(selection.timezone)}.getOrDefault(ZoneId.of("UTC"))
    val today=now.atZone(zone).toLocalDate()
    val target=if(selection.mode=="tomorrow")today.plusDays(1) else today
    fun date(record:TypedRecord)=record.values[data.dateField]?.let{runCatching{if(it.contains('T'))Instant.parse(it).atZone(zone).toLocalDate() else LocalDate.parse(it.take(10))}.getOrNull()}
    val dated=data.records.mapNotNull{record->date(record)?.let{it to record}}
    val matches=dated.filter{(date,_)->when(selection.mode){"next_available"->!date.isBefore(target);"current_week"->{val start=today.with(java.time.temporal.TemporalAdjusters.previousOrSame(firstDayOfWeek));!date.isBefore(start)&&!date.isAfter(start.plusDays(6))};"custom_range"->runCatching{!date.isBefore(LocalDate.parse(selection.customStartDate))&&!date.isAfter(LocalDate.parse(selection.customEndDate))}.getOrDefault(false);else->date==target}}
    return if(selection.mode=="next_available"&&matches.isNotEmpty()){val first=matches.minOf{it.first};matches.filter{it.first==first}.map{it.second}}else matches.map{it.second}
}

private fun field(record:TypedRecord,key:String)=if(key.isBlank())"" else record.values[key].orEmpty()
internal fun formatMetric(value:String,format:String,precision:Int,currencyCode:String?=null,regional:org.tilecast.player.network.RegionalFormatting?=null):String=regional.formatValue(value,format,precision,currencyCode)
internal fun formatTyped(value:String,column:FieldFormat,currencyCode:String?=null,regional:org.tilecast.player.network.RegionalFormatting?=null):String=column.prefix+regional.formatValue(value,column.format,column.precision,currencyCode)+column.suffix
private fun align(value:String)=when(value){"center"->TextAlign.Center;"right"->TextAlign.End;else->TextAlign.Start}
@Composable private fun WidgetSurface(background:String,padding:Int?,content:@Composable ()->Unit){Box(Modifier.fillMaxSize().background(parseExpandedColor(background)).padding((padding?:10).dp)){content()}}
@Composable private fun EmptyExpanded(text:String,color:String){Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center){Text(text,color=parseExpandedColor(color),fontSize=26.sp,textAlign=TextAlign.Center)}}
private fun parseExpandedColor(value:String)=runCatching{androidx.compose.ui.graphics.Color(android.graphics.Color.parseColor(value))}.getOrDefault(androidx.compose.ui.graphics.Color.Black)
