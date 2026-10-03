package main

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// persistentEnvNames: variáveis salvas no Windows (Usuário e Máquina).
func persistentEnvNames() map[string]bool {
	out := map[string]bool{}
	read := func(root registry.Key, path string) {
		k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
		if err != nil {
			return
		}
		defer k.Close()
		names, err := k.ReadValueNames(-1)
		if err != nil {
			return
		}
		for _, n := range names {
			out[strings.ToUpper(n)] = true
		}
	}
	read(registry.CURRENT_USER, `Environment`)
	read(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`)
	return out
}
