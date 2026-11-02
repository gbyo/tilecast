package org.tilecast.player.ui

import android.view.KeyEvent as AndroidKeyEvent
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation

/**
 * Focus for the control a remote should land on when a screen opens.
 * Without it the first OK press does nothing. Attach the returned
 * requester with `Modifier.focusRequester`.
 */
@Composable
fun rememberInitialFocus(key: Any? = Unit): FocusRequester {
    val requester = remember { FocusRequester() }
    LaunchedEffect(key) {
        withFrameNanos { }
        runCatching { requester.requestFocus() }
    }
    return requester
}

/**
 * A single-line field that works with a TV remote. Up and Down leave the
 * field (a plain text field keeps D-pad focus), OK opens the on-screen
 * keyboard, and the keyboard's action key submits.
 */
@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
    keyboardType: KeyboardType = KeyboardType.Uri,
    secret: Boolean = false,
) {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        textStyle = MaterialTheme.typography.titleLarge,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ImeAction.Go, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { keyboard?.hide(); onSubmit() }, onDone = { keyboard?.hide(); onSubmit() }),
        modifier = modifier.onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (event.key.nativeKeyCode) {
                AndroidKeyEvent.KEYCODE_DPAD_DOWN -> focus.moveFocus(FocusDirection.Down)
                AndroidKeyEvent.KEYCODE_DPAD_UP -> focus.moveFocus(FocusDirection.Up)
                AndroidKeyEvent.KEYCODE_DPAD_CENTER -> { keyboard?.show(); true }
                AndroidKeyEvent.KEYCODE_ENTER, AndroidKeyEvent.KEYCODE_NUMPAD_ENTER -> { keyboard?.hide(); onSubmit(); true }
                else -> false
            }
        },
    )
}

/** Attaches a requester from [rememberInitialFocus], or nothing. */
fun Modifier.initialFocus(requester: FocusRequester?): Modifier =
    if (requester == null) this else focusRequester(requester)
