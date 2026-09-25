package com.sovereign.runtime.android.runtime

enum class AuthorityProfile(
    val level: Int,
    val displayName: String,
) {
    OBSERVE(level = 1, displayName = "L1 Observe"),
    INTERACTION(level = 2, displayName = "L2 Interaction"),
    SYSTEM(level = 3, displayName = "L3 System (future)"),
}

enum class AndroidCapability(
    val requiredProfile: AuthorityProfile,
) {
    UI_OBSERVE(AuthorityProfile.OBSERVE),
    SCREEN_CAPTURE(AuthorityProfile.OBSERVE),
    UI_CLICK(AuthorityProfile.INTERACTION),
    UI_LONG_PRESS(AuthorityProfile.INTERACTION),
    UI_SET_TEXT(AuthorityProfile.INTERACTION),
    UI_SWIPE(AuthorityProfile.INTERACTION),
    GLOBAL_BACK(AuthorityProfile.INTERACTION),
    GLOBAL_HOME(AuthorityProfile.INTERACTION),
    GLOBAL_RECENTS(AuthorityProfile.INTERACTION),
    APP_LIST(AuthorityProfile.OBSERVE),
    APP_CURRENT(AuthorityProfile.OBSERVE),
    APP_LAUNCH(AuthorityProfile.INTERACTION),
    NOTIFICATION_LIST(AuthorityProfile.OBSERVE),
    SYSTEM_PACKAGE(AuthorityProfile.SYSTEM),
    SYSTEM_SETTINGS(AuthorityProfile.SYSTEM),
}
