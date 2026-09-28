package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"gopkg.in/yaml.v3"
)

// handlerRequestUse is what a handler reads from the request, found by
// reading its source. It is a floor, not a full model: a handler that hands
// the request to a helper, or reads a query key from a variable, is not
// seen. What it does see must be described in the contract.
type handlerRequestUse struct {
	decodesJSON bool
	queryKeys   map[string]bool
}

func isJSONDecodeCall(name string) bool {
	return name == "decodeJSON" || name == "decodeJSONLimit" || name == "decodeJSONReader" || name == "decodeDataSourceJSON"
}

// scanHandlerSources parses every non-test source file in this package and
// records, per function name, whether the function decodes a JSON body and
// which literal query keys it reads from r.URL.Query().
func scanHandlerSources(t *testing.T) map[string]*handlerRequestUse {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	dir := filepath.Dir(file)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	uses := map[string]*handlerRequestUse{}
	fset := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			use := &handlerRequestUse{queryKeys: map[string]bool{}}
			queryVars := map[string]bool{}
			isRequestQuery := func(expr ast.Expr) bool {
				call, ok := expr.(*ast.CallExpr)
				if !ok {
					return false
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				return ok && sel.Sel.Name == "Query"
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.AssignStmt:
					if len(node.Lhs) == 1 && len(node.Rhs) == 1 && isRequestQuery(node.Rhs[0]) {
						if id, ok := node.Lhs[0].(*ast.Ident); ok {
							queryVars[id.Name] = true
						}
					}
				case *ast.CallExpr:
					switch fun := node.Fun.(type) {
					case *ast.Ident:
						if isJSONDecodeCall(fun.Name) {
							use.decodesJSON = true
						}
					case *ast.SelectorExpr:
						if isJSONDecodeCall(fun.Sel.Name) {
							use.decodesJSON = true
						}
						if (fun.Sel.Name == "Get" || fun.Sel.Name == "Has") && len(node.Args) == 1 {
							literal, isLiteral := node.Args[0].(*ast.BasicLit)
							if !isLiteral {
								break
							}
							receiverIsQuery := isRequestQuery(fun.X)
							if id, ok := fun.X.(*ast.Ident); ok && queryVars[id.Name] {
								receiverIsQuery = true
							}
							if receiverIsQuery {
								use.queryKeys[strings.Trim(literal.Value, `"`)] = true
							}
						}
					}
				}
				return true
			})
			uses[fn.Name.Name] = use
		}
	}
	return uses
}

type routeHandler struct{ method, path, function string }

func productionRouteHandlers(t *testing.T) []routeHandler {
	t.Helper()
	s := productionServerForRoutes()
	var found []routeHandler
	collect := func(handler http.Handler) {
		walkable, ok := handler.(chi.Routes)
		if !ok {
			t.Fatalf("handler %T is not a chi router", handler)
		}
		err := chi.Walk(walkable, func(method, pattern string, endpoint http.Handler, _ ...func(http.Handler) http.Handler) error {
			if !strings.HasPrefix(pattern, "/api/v1") {
				return nil
			}
			fn := ""
			if hf, ok := endpoint.(http.HandlerFunc); ok {
				fn = runtime.FuncForPC(reflect.ValueOf(hf).Pointer()).Name()
				fn = fn[strings.LastIndex(fn, ".")+1:]
				fn = strings.TrimSuffix(fn, "-fm")
			}
			found = append(found, routeHandler{method, normalizeRoutePattern(pattern), fn})
			return nil
		})
		if err != nil {
			t.Fatalf("walk production routes: %v", err)
		}
	}
	collect(s.routes())
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	collect(s.previewRoutes(stub))
	collect(s.loginBackgroundRoutes(stub))
	return found
}

type contractOperation struct {
	hasJSONBody bool
	queryParams map[string]bool
}

// contractOperations reads request-side facts (JSON body, declared query
// parameters, including path-level and $ref parameters) per METHOD + path.
func contractOperations(t *testing.T) map[string]contractOperation {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "docs", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read composed OpenAPI: %v", err)
	}
	var doc struct {
		Paths      map[string]map[string]yaml.Node `yaml:"paths"`
		Components struct {
			Parameters map[string]struct {
				Name string `yaml:"name"`
				In   string `yaml:"in"`
			} `yaml:"parameters"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse composed OpenAPI: %v", err)
	}
	type parameter struct {
		Name string `yaml:"name"`
		In   string `yaml:"in"`
		Ref  string `yaml:"$ref"`
	}
	queryNames := func(params []parameter, into map[string]bool) {
		for _, p := range params {
			if p.Ref != "" {
				p.Name, p.In = doc.Components.Parameters[strings.TrimPrefix(p.Ref, "#/components/parameters/")].Name, doc.Components.Parameters[strings.TrimPrefix(p.Ref, "#/components/parameters/")].In
			}
			if p.In == "query" {
				into[p.Name] = true
			}
		}
	}
	ops := map[string]contractOperation{}
	for path, item := range doc.Paths {
		var shared struct {
			Parameters []parameter `yaml:"parameters"`
		}
		if node, ok := item["parameters"]; ok {
			_ = node.Decode(&shared.Parameters)
		}
		for method, node := range item {
			if method == "parameters" {
				continue
			}
			var op struct {
				Parameters  []parameter `yaml:"parameters"`
				RequestBody *struct {
					Content map[string]any `yaml:"content"`
				} `yaml:"requestBody"`
			}
			if err := node.Decode(&op); err != nil {
				continue
			}
			entry := contractOperation{queryParams: map[string]bool{}}
			queryNames(shared.Parameters, entry.queryParams)
			queryNames(op.Parameters, entry.queryParams)
			if op.RequestBody != nil {
				_, entry.hasJSONBody = op.RequestBody.Content["application/json"]
			}
			ops[strings.ToUpper(method)+" "+path] = entry
		}
	}
	return ops
}

// TestRequestContractParity fails when a handler decodes a JSON body but
// the contract declares no application/json requestBody, or when a handler
// reads a literal query key the contract does not declare. Generated
// clients take their request types only from the contract, so a missing
// request description is a wrong client, not a documentation gap.
func TestRequestContractParity(t *testing.T) {
	uses := scanHandlerSources(t)
	operations := contractOperations(t)
	checked := 0
	for _, route := range productionRouteHandlers(t) {
		use, ok := uses[route.function]
		if !ok {
			continue
		}
		operation, described := operations[route.method+" "+route.path]
		if !described {
			continue // TestRouteContractParity owns undescribed routes.
		}
		checked++
		if use.decodesJSON && !operation.hasJSONBody {
			t.Errorf("%s %s (%s) decodes a JSON body but the contract has no application/json requestBody", route.method, route.path, route.function)
		}
		var undeclared []string
		for key := range use.queryKeys {
			if !operation.queryParams[key] {
				undeclared = append(undeclared, key)
			}
		}
		sort.Strings(undeclared)
		if len(undeclared) > 0 {
			t.Errorf("%s %s (%s) reads query keys the contract does not declare: %s", route.method, route.path, route.function, strings.Join(undeclared, ", "))
		}
	}
	if checked < 200 {
		t.Fatalf("checked only %d routes; handler resolution is broken", checked)
	}
}
