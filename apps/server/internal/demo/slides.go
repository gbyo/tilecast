package demo

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// slide is a sample announcement. Slides are drawn at seed time rather than
// committed as binary files, so the demo dataset stays reviewable as code and
// every reset uploads byte-identical images.
type slide struct {
	Filename   string
	Title      string
	Subtitle   string
	Background color.RGBA
	Accent     color.RGBA
	Width      int
	Height     int
}

var (
	fontsOnce  sync.Once
	fontsErr   error
	boldFont   *opentype.Font
	normalFont *opentype.Font
)

func loadFonts() error {
	fontsOnce.Do(func() {
		if boldFont, fontsErr = opentype.Parse(gobold.TTF); fontsErr != nil {
			return
		}
		normalFont, fontsErr = opentype.Parse(goregular.TTF)
	})
	return fontsErr
}

// render draws the slide as a PNG: a flat background, an accent rule, the
// title, the subtitle, and a footer naming the demo organization.
func (s slide) render() ([]byte, error) {
	if err := loadFonts(); err != nil {
		return nil, fmt.Errorf("load slide fonts: %w", err)
	}
	width, height := s.Width, s.Height
	if width == 0 || height == 0 {
		width, height = 1920, 1080
	}
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: s.Background}, image.Point{}, draw.Src)
	margin := width / 12
	rule := image.Rect(margin, height*2/5, margin+width/6, height*2/5+height/60)
	draw.Draw(canvas, rule, &image.Uniform{C: s.Accent}, image.Point{}, draw.Src)
	footer := image.Rect(0, height-height/10, width, height)
	draw.Draw(canvas, footer, &image.Uniform{C: color.RGBA{A: 60}}, image.Point{}, draw.Over)

	white := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	if err := drawText(canvas, boldFont, float64(height)/9, s.Title, margin, height*2/5-height/20, white); err != nil {
		return nil, err
	}
	if err := drawText(canvas, normalFont, float64(height)/22, s.Subtitle, margin, height*2/5+height/8, white); err != nil {
		return nil, err
	}
	if err := drawText(canvas, normalFont, float64(height)/36, "Tilecast Demo District", margin, height-height/28, white); err != nil {
		return nil, err
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		return nil, fmt.Errorf("encode slide: %w", err)
	}
	return encoded.Bytes(), nil
}

func drawText(canvas draw.Image, source *opentype.Font, size float64, text string, x, baseline int, fill color.Color) error {
	face, err := opentype.NewFace(source, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return fmt.Errorf("prepare slide font: %w", err)
	}
	defer face.Close()
	drawer := font.Drawer{Dst: canvas, Src: image.NewUniform(fill), Face: face, Dot: fixed.P(x, baseline)}
	drawer.DrawString(text)
	return nil
}

func rgb(value uint32) color.RGBA {
	return color.RGBA{R: uint8(value >> 16), G: uint8(value >> 8), B: uint8(value), A: 255}
}
