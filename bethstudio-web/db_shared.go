package main

const dbWindowTitle = "Banco de dados"

// dbStandalone: this process is the database window, not the Studio.
// Windows sets it when that window claims its mutex; other platforms set
// it when --db starts.
var dbStandalone bool
