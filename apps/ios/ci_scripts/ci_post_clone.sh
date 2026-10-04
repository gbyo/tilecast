#!/bin/sh
set -e

# Xcode Cloud cannot interactively approve Swift package build plugins.
# Note: "Validatation" is intentionally misspelled; that is Xcode's key.
defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES
