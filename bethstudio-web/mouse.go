package main

import "errors"

// mouseMessage valida um evento de mouse da interface e monta o pedido para a
// ponte (patch 0204). So' valores de uma lista fixa passam.
func mouseMessage(req clientRequest) (map[string]any, error) {
	if req.PaneID == nil || *req.PaneID < 0 || req.X == nil || req.Y == nil {
		return nil, errors.New("mouse: pane_id, x e y são obrigatórios")
	}
	switch req.Kind {
	case "press", "release", "move":
	default:
		return nil, errors.New("mouse: kind inválido")
	}
	switch req.Button {
	case "left", "middle", "right", "wheel_up", "wheel_down", "wheel_left", "wheel_right", "none":
	default:
		return nil, errors.New("mouse: button inválido")
	}
	if *req.X < 0 || *req.X >= 1000 || *req.Y < 0 || *req.Y >= 1000 {
		return nil, errors.New("mouse: fora da tela")
	}
	return map[string]any{
		"op": "mouse", "pane_id": *req.PaneID, "kind": req.Kind, "button": req.Button,
		"x": *req.X, "y": *req.Y, "shift": req.Shift, "ctrl": req.Ctrl, "alt": req.Alt,
	}, nil
}
